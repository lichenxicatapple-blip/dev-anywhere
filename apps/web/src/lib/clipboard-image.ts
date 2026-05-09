export type ClipboardImagePayload = {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataBase64: string;
  fileName?: string;
};

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

type ClipboardItemLike = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;
type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike>;
  files?: ArrayLike<File>;
};

const SUPPORTED_IMAGE_TYPES = new Set<ClipboardImagePayload["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isSupportedImageType(type: string): type is ClipboardImagePayload["mimeType"] {
  return SUPPORTED_IMAGE_TYPES.has(type as ClipboardImagePayload["mimeType"]);
}

export function getClipboardImageFile(clipboardData: ClipboardDataLike | null): File | null {
  if (!clipboardData) return null;

  const items = Array.from(clipboardData.items ?? []);
  for (const item of items) {
    if (item.kind !== "file" || !isSupportedImageType(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  const files = Array.from(clipboardData.files ?? []);
  return files.find((file) => isSupportedImageType(file.type)) ?? null;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("读取剪贴板图片失败"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("读取剪贴板图片失败"));
    });
    reader.readAsArrayBuffer(file);
  });
}

export async function fileToClipboardImagePayload(file: File): Promise<ClipboardImagePayload> {
  if (!isSupportedImageType(file.type)) {
    throw new Error("不支持这种图片格式");
  }
  if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("图片超过 10MB 限制");
  }
  const bytes = await readFileBytes(file);
  return {
    mimeType: file.type,
    dataBase64: bytesToBase64(bytes),
    ...(file.name ? { fileName: file.name } : {}),
  };
}

export function clipboardImagePathToken(path: string): string {
  return `${path.startsWith("@") ? path : `@${path}`} `;
}

export function insertTextAtSelection(
  value: string,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return {
    value: `${value.slice(0, start)}${text}${value.slice(end)}`,
    cursor: start + text.length,
  };
}
