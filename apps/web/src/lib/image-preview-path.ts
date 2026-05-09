const IMAGE_PATH_RE =
  /@?(?:\.dev-anywhere\/|\.{1,2}\/|\/)[^\s`"'<>]*?\.(?:png|jpe?g|webp|gif)(?=[\s`"'<>),.;:!?，。；：！？、]|$)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

export function isImagePreviewPath(value: string): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  return (
    (path.startsWith("/") ||
      path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith(".dev-anywhere/")) &&
    IMAGE_EXT_RE.test(path)
  );
}

export function extractImagePreviewPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(IMAGE_PATH_RE)) {
    const path = trimPathToken(match[0] ?? "");
    if (!isImagePreviewPath(path) || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
