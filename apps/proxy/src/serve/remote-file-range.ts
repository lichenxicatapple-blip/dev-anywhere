export interface RemoteFileByteRange {
  start: number;
  end: number;
}

/** A single HTTP byte range; multipart ranges are deliberately unsupported. */
export function parseRemoteFileRange(
  value: string | undefined,
  size: number,
): RemoteFileByteRange | "invalid" | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}
