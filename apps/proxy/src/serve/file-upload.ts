import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode } from "@dev-anywhere/shared";

// 落系统临时目录避免污染 user repo / 触发 .gitignore: CLI agent 看到绝对路径不受 cwd
// 内 ignore 规则限制。文件名平铺单层 + 6 位随机后缀, 控制 mention 长度。
// 用户原 fileName 只取扩展, 不保留主干 (中文 / 长名 / 空格都会让 mention 变长)。
const DEFAULT_DATA_DIR = join(tmpdir(), "dev-anywhere");
const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FILE_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4;
const SAFE_EXT_RE = /^[A-Za-z0-9]{1,6}$/;

type FileUploadRequest = {
  sessionId: string;
  mimeType: string;
  dataBase64: string;
  fileName: string;
};

type FileUploadResult = {
  success: boolean;
  // 失败时不填,避免空字符串通过 schema 的 z.string().optional() 校验。
  path?: string;
  error?: string;
  errorCode?: (typeof ControlErrorCode)[keyof typeof ControlErrorCode];
};

type FileUploadOptions = {
  dataDir?: string;
  randomSuffix?: () => string;
};

function normalizeBase64(input: string): string {
  return input.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
}

function decodeBase64File(dataBase64: string): Buffer {
  const normalized = normalizeBase64(dataBase64);
  if (normalized.length > MAX_FILE_UPLOAD_BASE64_LENGTH) {
    throw new Error("文件超过 100MB 限制");
  }
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("文件数据不是有效的 base64");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("文件数据为空");
  if (buffer.length > MAX_FILE_UPLOAD_BYTES) {
    throw new Error("文件超过 100MB 限制");
  }
  return buffer;
}

function safeExtension(fileName: string): string {
  // 单段扩展, 多扩展 (.tar.gz / .min.js) 只保留最后一段; agent 看 mimeType 即可,
  // 路径里只需要保留类型 hint。非 ASCII / 含路径分隔符等的扩展直接丢。
  const raw = extname(fileName).slice(1).toLowerCase();
  return SAFE_EXT_RE.test(raw) ? `.${raw}` : "";
}

export async function saveFileUpload(
  request: FileUploadRequest,
  options: FileUploadOptions = {},
): Promise<FileUploadResult> {
  try {
    const buffer = decodeBase64File(request.dataBase64);
    const suffix = options.randomSuffix?.() ?? nanoid(6);
    const fileName = `up-${suffix}${safeExtension(request.fileName)}`;
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
