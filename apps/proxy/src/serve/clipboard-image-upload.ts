import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode } from "@dev-anywhere/shared";

// 落系统临时目录避免污染 user repo / 触发 .gitignore: CLI agent 看到绝对路径不受 cwd
// 内 ignore 规则限制。文件名平铺单层、6 位随机后缀, 不带 sessionId / 时间戳, 控制 mention
// 长度 (用户在 prompt 里看到 @<path> 越短越好)。
const DEFAULT_DATA_DIR = join(tmpdir(), "dev-anywhere");
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_BASE64_LENGTH = Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4;
const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
] as const);

export type ClipboardImageUploadRequest = {
  sessionId: string;
  mimeType: string;
  dataBase64: string;
  fileName?: string;
};

type ClipboardImageUploadResult = {
  success: boolean;
  // 失败时不填,避免空字符串通过 schema 的 z.string().optional() 校验。
  path?: string;
  error?: string;
  errorCode?: (typeof ControlErrorCode)[keyof typeof ControlErrorCode];
};

type ClipboardImageUploadOptions = {
  dataDir?: string;
  randomSuffix?: () => string;
};

function normalizeBase64(input: string): string {
  return input.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
}

function decodeBase64Image(dataBase64: string): Buffer {
  const normalized = normalizeBase64(dataBase64);
  if (normalized.length > MAX_CLIPBOARD_IMAGE_BASE64_LENGTH) {
    throw new Error("图片超过 10MB 限制");
  }
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("图片数据不是有效的 base64");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("图片数据为空");
  if (buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("图片超过 10MB 限制");
  }
  return buffer;
}

export function saveClipboardImageUpload(
  request: ClipboardImageUploadRequest,
  options: ClipboardImageUploadOptions = {},
): ClipboardImageUploadResult {
  const extension = IMAGE_EXTENSIONS.get(request.mimeType);
  if (!extension) {
    return {
      success: false,
      error: "不支持这种图片格式",
      errorCode: ControlErrorCode.UNKNOWN,
    };
  }

  try {
    const buffer = decodeBase64Image(request.dataBase64);
    const suffix = options.randomSuffix?.() ?? nanoid(6);
    const fileName = `paste-${suffix}.${extension}`;
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    const path = join(dataDir, fileName);

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, buffer, { mode: 0o600 });
    return { success: true, path };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: ControlErrorCode.UNKNOWN,
    };
  }
}
