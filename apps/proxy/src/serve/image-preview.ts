import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import { classifyPathError } from "./path-errors.js";

const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

type ImagePreviewRequest = {
  sessionId: string;
  path: string;
};

type ImagePreviewResult = {
  success: boolean;
  sessionId: string;
  path: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataBase64?: string;
  size?: number;
  error?: string;
  errorCode?: ControlErrorCodeType;
};

type ImagePreviewOptions = {
  cwd: string;
  tmpDir?: string;
  previewRoots?: string[];
  maxBytes?: number;
};

function isInsideRoot(realFilePath: string, realRootPath: string): boolean {
  const rel = relative(realRootPath, realFilePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowedRoots(options: ImagePreviewOptions): string[] {
  return [options.cwd, options.tmpDir ?? tmpdir(), ...(options.previewRoots ?? [])]
    .map((root) => root.trim())
    .filter(Boolean)
    .flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
}

function resolvePreviewPath(rawPath: string, options: ImagePreviewOptions): string {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(options.cwd, rawPath);
  const realCandidate = realpathSync(candidate);
  if (!allowedRoots(options).some((root) => isInsideRoot(realCandidate, root))) {
    throw Object.assign(new Error("图片路径不在允许预览的目录内"), {
      errorCode: ControlErrorCode.INVALID_PATH,
    });
  }
  return realCandidate;
}

function detectImageMime(buffer: Buffer): ImagePreviewResult["mimeType"] | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  return undefined;
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

export function loadImagePreview(
  request: ImagePreviewRequest,
  options: ImagePreviewOptions,
): ImagePreviewResult {
  try {
    const resolvedPath = resolvePreviewPath(request.path, options);
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      return {
        success: false,
        sessionId: request.sessionId,
        path: request.path,
        error: "路径不是图片文件",
        errorCode: ControlErrorCode.INVALID_PATH,
      };
    }
    const maxBytes = options.maxBytes ?? MAX_IMAGE_PREVIEW_BYTES;
    if (stat.size > maxBytes) {
      return {
        success: false,
        sessionId: request.sessionId,
        path: request.path,
        error: "图片超过 10MB 限制",
        errorCode: ControlErrorCode.UNKNOWN,
      };
    }

    const buffer = readFileSync(resolvedPath);
    const mimeType = detectImageMime(buffer);
    if (!mimeType) {
      return {
        success: false,
        sessionId: request.sessionId,
        path: request.path,
        error: "不支持这种图片格式",
        errorCode: ControlErrorCode.UNKNOWN,
      };
    }

    return {
      success: true,
      sessionId: request.sessionId,
      path: request.path,
      mimeType,
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
