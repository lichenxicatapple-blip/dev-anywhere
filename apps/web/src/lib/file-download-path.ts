// 任意文件下载路径提取: 与 image-preview-path 形状对称, 但排除图片扩展, 让两条 link provider
// 在同一行不会双重 underline。要求必有扩展 (避免误把纯目录如 /Users 当文件链接)。

// 负 lookbehind 防止匹配 URL (https://... 里的 //example...) 或路径中段 (a/b/c.txt 不该从 b 切)。
const FILE_PATH_RE =
  /(?<![A-Za-z0-9:/])@?(?:\.dev-anywhere\/|\.{1,2}\/|\/)[^\s`"'<>]*?\.[A-Za-z0-9]{1,8}(?=[\s`"'<>),.;:!?，。；：！？、]|$)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

export function isFileDownloadPath(value: string): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (IMAGE_EXT_RE.test(path)) return false;
  if (!FILE_EXT_RE.test(path)) return false;
  return (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith(".dev-anywhere/")
  );
}

export function extractFileDownloadPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const path = trimPathToken(match[0] ?? "");
    if (!isFileDownloadPath(path) || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
