import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

const EXT_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext] ?? "application/octet-stream";
}

export function resolveRemoteFilePath(rawPath: string, cwd: string): string {
  const expandedPath =
    rawPath === "~" || rawPath.startsWith("~/") ? resolve(homedir(), rawPath.slice(2)) : rawPath;
  const candidate = isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(cwd, expandedPath);
  return realpathSync(candidate);
}
