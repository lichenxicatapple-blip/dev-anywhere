import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { DATA_DIR } from "../common/paths.js";

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
  path: string;
  error?: string;
  errorCode?: ControlErrorCode;
};

type ClipboardImageUploadOptions = {
  dataDir?: string;
  cwd?: string;
  now?: () => number;
  randomSuffix?: () => string;
};

function formatTimestamp(ms: number): string {
  const [date, time = "000000"] = new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .split("T");
  return `${date.replace(/-/g, "")}-${time.replace(/:/g, "")}`;
}

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

function resolveChildDir(rootPath: string, ...segments: string[]): string {
  const root = resolve(rootPath);
  const uploadDir = resolve(root, ...segments);
  const relativePath = relative(root, uploadDir);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("会话路径无效");
  }
  return uploadDir;
}

function resolveSessionClipboardDir(dataDir: string, sessionId: string): string {
  return resolveChildDir(dataDir, sessionId, "clipboard");
}

function normalizeGitignoreLine(line: string): string {
  return line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function ensureProjectClipboardIgnored(cwd: string): void {
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
    // Ignore-file updates are best-effort; image upload should still succeed.
  }
}

function trySaveProjectClipboardImage(options: {
  cwd?: string;
  sessionId: string;
  fileName: string;
  buffer: Buffer;
}): ClipboardImageUploadResult | null {
  if (!options.cwd) return null;

  try {
    const cwd = resolve(options.cwd);
    if (!statSync(cwd).isDirectory()) return null;
    const clipboardRoot = resolve(cwd, ".dev-anywhere", "clipboard");
    const uploadDir = resolveChildDir(clipboardRoot, options.sessionId);
    const path = join(uploadDir, options.fileName);

    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(path, options.buffer, { mode: 0o600 });
    ensureProjectClipboardIgnored(cwd);
    return { success: true, path: relative(cwd, path) };
  } catch {
    return null;
  }
}

export function saveClipboardImageUpload(
  request: ClipboardImageUploadRequest,
  options: ClipboardImageUploadOptions = {},
): ClipboardImageUploadResult {
  const extension = IMAGE_EXTENSIONS.get(request.mimeType);
  if (!extension) {
    return {
      success: false,
      path: "",
      error: "不支持这种图片格式",
      errorCode: ControlErrorCode.UNKNOWN,
    };
  }

  try {
    const buffer = decodeBase64Image(request.dataBase64);
    const now = options.now ?? Date.now;
    const suffix = options.randomSuffix?.() ?? nanoid(6);
    const fileName = `pasted-${formatTimestamp(now())}-${suffix}.${extension}`;
    const projectResult = trySaveProjectClipboardImage({
      cwd: options.cwd,
      sessionId: request.sessionId,
      fileName,
      buffer,
    });
    if (projectResult) return projectResult;

    const dataDir = options.dataDir ?? DATA_DIR;
    const uploadDir = resolveSessionClipboardDir(dataDir, request.sessionId);
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
