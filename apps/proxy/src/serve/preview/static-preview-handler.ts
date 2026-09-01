import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { sendPreviewError, setPreviewResponseHeaders } from "./preview-response-headers.js";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

interface ByteRange {
  start: number;
  end: number;
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function hiddenOrDependencyPath(path: string): boolean {
  return path
    .split("/")
    .filter(Boolean)
    .some((part) => part.startsWith(".") || part.toLowerCase() === "node_modules");
}

function decodeRequestPath(requestUrl: string): string | null {
  const rawPath = requestUrl.split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.split("/").some((part) => part === "..")) return null;
  return decoded;
}

function parseRange(value: string | undefined, size: number): ByteRange | "invalid" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function matchesFreshness(request: IncomingMessage, etag: string, mtimeMs: number): boolean {
  if (request.headers["if-none-match"] === etag) return true;
  const ifModifiedSince = request.headers["if-modified-since"];
  if (!ifModifiedSince) return false;
  const parsed = Date.parse(ifModifiedSince);
  return Number.isFinite(parsed) && Math.floor(mtimeMs / 1000) <= Math.floor(parsed / 1000);
}

export class StaticPreviewHandler {
  constructor(
    private readonly rootPath: string,
    private readonly entryPath: string,
    private readonly documentFallback = false,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      setPreviewResponseHeaders(response);
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }

    const decodedPath = decodeRequestPath(request.url ?? "/");
    if (decodedPath === null || hiddenOrDependencyPath(decodedPath)) {
      sendPreviewError(response, 404, "页面不存在");
      return;
    }

    const relativePath = decodedPath.replace(/^\/+/, "");
    let candidatePath = resolve(this.rootPath, relativePath || ".");
    if (!isWithinRoot(this.rootPath, candidatePath)) {
      sendPreviewError(response, 404, "页面不存在");
      return;
    }

    try {
      let candidateStat;
      try {
        candidateStat = await stat(candidatePath);
        if (candidateStat.isDirectory()) {
          candidatePath = resolve(candidatePath, "index.html");
          candidateStat = await stat(candidatePath);
        }
      } catch (error) {
        const acceptsHtml = (request.headers.accept ?? "").toLowerCase().includes("text/html");
        const firstSegment = relativePath.split("/", 1)[0]?.toLowerCase();
        const documentFallback =
          this.documentFallback &&
          acceptsHtml &&
          !extname(relativePath) &&
          firstSegment !== "api" &&
          request.headers["sec-fetch-dest"] !== "script" &&
          request.headers["sec-fetch-dest"] !== "style" &&
          request.headers["sec-fetch-dest"] !== "image";
        if (!documentFallback) throw error;
        candidatePath = resolve(this.rootPath, this.entryPath);
        candidateStat = await stat(candidatePath);
      }
      if (!candidateStat.isFile()) throw new Error("not a file");

      const canonicalPath = await realpath(candidatePath);
      if (!isWithinRoot(this.rootPath, canonicalPath)) {
        sendPreviewError(response, 404, "页面不存在");
        return;
      }
      const canonicalRelativePath = relative(this.rootPath, canonicalPath).split(sep).join("/");
      if (hiddenOrDependencyPath(canonicalRelativePath)) {
        sendPreviewError(response, 404, "页面不存在");
        return;
      }

      const file = await open(canonicalPath, "r");
      let fileStat;
      try {
        const canonicalAfterOpen = await realpath(canonicalPath);
        const pathStat = await stat(canonicalAfterOpen);
        fileStat = await file.stat();
        const canonicalAfterOpenRelative = relative(this.rootPath, canonicalAfterOpen)
          .split(sep)
          .join("/");
        if (
          !isWithinRoot(this.rootPath, canonicalAfterOpen) ||
          hiddenOrDependencyPath(canonicalAfterOpenRelative) ||
          fileStat.dev !== pathStat.dev ||
          fileStat.ino !== pathStat.ino
        ) {
          await file.close();
          sendPreviewError(response, 404, "页面不存在");
          return;
        }
      } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
      }
      if (!fileStat.isFile()) {
        await file.close();
        sendPreviewError(response, 404, "页面不存在");
        return;
      }

      const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
      setPreviewResponseHeaders(response);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("ETag", etag);
      response.setHeader("Last-Modified", fileStat.mtime.toUTCString());
      response.setHeader(
        "Content-Type",
        MIME_TYPES[extname(canonicalPath).toLowerCase()] ?? "application/octet-stream",
      );

      if (matchesFreshness(request, etag, fileStat.mtimeMs)) {
        await file.close();
        response.statusCode = 304;
        response.end();
        return;
      }

      const range = parseRange(
        Array.isArray(request.headers.range) ? request.headers.range[0] : request.headers.range,
        fileStat.size,
      );
      if (range === "invalid" || (fileStat.size === 0 && range !== null)) {
        await file.close();
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${fileStat.size}`);
        response.end();
        return;
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, fileStat.size - 1);
      if (range) {
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
      } else {
        response.statusCode = 200;
      }
      response.setHeader("Content-Length", range ? end - start + 1 : fileStat.size);

      if (request.method === "HEAD" || fileStat.size === 0) {
        await file.close();
        response.end();
        return;
      }

      const stream = file.createReadStream({
        autoClose: true,
        start,
        end,
      });
      stream.once("error", () => {
        if (!response.headersSent) sendPreviewError(response, 500, "无法读取网页文件");
        else response.destroy();
      });
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    } catch {
      sendPreviewError(response, 404, "页面不存在");
    }
  }
}
