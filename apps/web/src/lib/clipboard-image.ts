type SupportedClipboardImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

type ClipboardItemLike = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;
type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike>;
  files?: ArrayLike<File>;
};

const SUPPORTED_IMAGE_TYPES = new Set<SupportedClipboardImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isSupportedImageType(type: string): type is SupportedClipboardImageMimeType {
  return SUPPORTED_IMAGE_TYPES.has(type as SupportedClipboardImageMimeType);
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

export function clipboardImagePathMention(path: string): string {
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
