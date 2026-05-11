import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { DATA_DIR } from "../common/paths.js";

// 单租户场景下文件上传上限大于剪贴板图片: 视频 / 日志包等可能 30-50MB。
const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FILE_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4;
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

export type FileUploadRequest = {
  sessionId: string;
  mimeType: string;
  dataBase64: string;
  fileName: string;
};

export type FileUploadResult = {
  success: boolean;
  path: string;
  error?: string;
  errorCode?: ControlErrorCode;
};

type FileUploadOptions = {
  dataDir?: string;
  cwd?: string;
  now?: () => number;
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

function sanitizeFileName(fileName: string, fallbackPrefix: string, suffix: string): string {
  const base = basename(fileName).trim();
  if (base && SAFE_FILENAME_RE.test(base)) return base;
  // 含路径分隔符 / 非 ASCII / 控制字符等不安全名: 拆出扩展名 (若仍合法) 并接随机后缀。
  const extMatch = base.match(/\.([A-Za-z0-9]{1,6})$/);
  const ext = extMatch ? `.${extMatch[1]}` : "";
  return `${fallbackPrefix}-${suffix}${ext}`;
}

function resolveChildDir(rootPath: string, ...segments: string[]): string {
  const root = resolve(rootPath);
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("会话路径无效");
  }
  return target;
}

function normalizeGitignoreLine(line: string): string {
  return line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function ensureProjectUploadIgnored(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) return;
  try {
    const current = readFileSync(gitignorePath, "utf-8");
    const alreadyIgnored = current
      .split(/\r?\n/)
      .some((line) => normalizeGitignoreLine(line) === ".dev-anywhere");
    if (alreadyIgnored) return;
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${current}${separator}.dev-anywhere/\n`);
  } catch {
    // best-effort
  }
}

function trySaveProjectUpload(options: {
  cwd?: string;
  sessionId: string;
  fileName: string;
  buffer: Buffer;
}): FileUploadResult | null {
  if (!options.cwd) return null;
  try {
    const cwd = resolve(options.cwd);
    if (!statSync(cwd).isDirectory()) return null;
    const uploadsRoot = resolve(cwd, ".dev-anywhere", "uploads");
    const uploadDir = resolveChildDir(uploadsRoot, options.sessionId);
    const path = join(uploadDir, options.fileName);
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(path, options.buffer, { mode: 0o600 });
    ensureProjectUploadIgnored(cwd);
    return { success: true, path: relative(cwd, path) };
  } catch (err) {
    serviceLogger.warn(
      { sessionId: options.sessionId, cwd: options.cwd, error: String(err) },
      "Project upload write failed; falling back to data dir",
    );
    return null;
  }
}

export async function saveFileUpload(
  request: FileUploadRequest,
  options: FileUploadOptions = {},
): Promise<FileUploadResult> {
  try {
    const buffer = decodeBase64File(request.dataBase64);
    const now = options.now ?? Date.now;
    const suffix = options.randomSuffix?.() ?? nanoid(6);
    const stamped = new Date(now())
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14);
    const fileName = sanitizeFileName(request.fileName, `upload-${stamped}`, suffix);

    const projectResult = trySaveProjectUpload({
      cwd: options.cwd,
      sessionId: request.sessionId,
      fileName,
      buffer,
    });
    if (projectResult) return projectResult;

    const dataDir = options.dataDir ?? DATA_DIR;
    const uploadDir = resolveChildDir(dataDir, request.sessionId, "uploads");
    const path = join(uploadDir, fileName);
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(path, buffer, { mode: 0o600 });
    return { success: true, path };
  } catch (err) {
    return {
      success: false,
      path: "",
      error: err instanceof Error ? err.message : String(err),
      errorCode: ControlErrorCode.UNKNOWN,
    };
  }
}
