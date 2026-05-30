import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import { classifyPathError } from "./path-errors.js";

// 单租户场景下不做白名单, 由 size cap 兜底; 100MB 已经远超日常 log/diff/截图。
const MAX_FILE_DOWNLOAD_BYTES = 100 * 1024 * 1024;

type FileDownloadRequest = {
  sessionId: string;
  path: string;
};

type FileDownloadResult = {
  success: boolean;
  sessionId: string;
  path: string;
  mimeType?: string;
  dataBase64?: string;
  size?: number;
  error?: string;
  errorCode?: ControlErrorCodeType;
};

type FileDownloadOptions = {
  cwd: string;
  maxBytes?: number;
};

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

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext] ?? "application/octet-stream";
}

function resolveDownloadPath(rawPath: string, cwd: string): string {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  return realpathSync(candidate);
}

function errorCode(err: unknown): ControlErrorCodeType {
  if (
    err instanceof Error &&
    "errorCode" in err &&
    typeof (err as { errorCode?: unknown }).errorCode === "string"
  ) {
    return (err as { errorCode: ControlErrorCodeType }).errorCode;
  }
  return classifyPathError(err);
}

export function loadFileDownload(
  request: FileDownloadRequest,
  options: FileDownloadOptions,
): FileDownloadResult {
  try {
    const resolvedPath = resolveDownloadPath(request.path, options.cwd);
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      return {
        success: false,
        sessionId: request.sessionId,
        path: request.path,
        error: "路径不是普通文件",
        errorCode: ControlErrorCode.INVALID_PATH,
      };
    }
    const maxBytes = options.maxBytes ?? MAX_FILE_DOWNLOAD_BYTES;
    if (stat.size > maxBytes) {
      return {
        success: false,
        sessionId: request.sessionId,
        path: request.path,
        error: `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
        errorCode: ControlErrorCode.UNKNOWN,
      };
    }

    const buffer = readFileSync(resolvedPath);
    return {
      success: true,
      sessionId: request.sessionId,
      path: request.path,
      mimeType: guessMimeType(resolvedPath),
      dataBase64: buffer.toString("base64"),
      size: buffer.length,
    };
  } catch (err) {
    return {
      success: false,
      sessionId: request.sessionId,
      path: request.path,
      error: err instanceof Error ? err.message : String(err),
      errorCode: errorCode(err),
    };
  }
}
