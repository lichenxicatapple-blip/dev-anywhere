type ClipboardItemLike = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;
type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike>;
  files?: ArrayLike<File>;
};

/** Browser files/items usually describe the same payload; choose one source, preserving order. */
export function getClipboardFiles(clipboardData: ClipboardDataLike | null): File[] {
  if (!clipboardData) return [];
  const files = Array.from(clipboardData.files ?? []);
  if (files.length > 0) return files;
  return Array.from(clipboardData.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
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
