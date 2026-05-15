// 任意文件下载路径提取: 与 image-preview-path 形状对称, 但排除图片扩展, 让两条 link provider
// 在同一行不会双重 underline。要求必有扩展 (避免误把纯目录如 /Users 当文件链接)。

// 负 lookbehind 防止匹配 URL (https://... 里的 //example...) 或路径中段 (a/b/c.txt 不该从 b 切)。
// 路径主干用 greedy `*` 而非 lazy `*?`: 双扩展 (.tar.gz / .min.js / .d.ts) 在 lazy 下只会匹配
// 到第一个扩展段 (`.tar`) 即停止。greedy 模式下延伸到下一空白前, 扩展子表达式
// `\.[A-Za-z0-9]{1,8}` 回溯到最末段, 支持任意层数扩展。
// 起始字符放开 (不再要求 ./ / .. .dev-anywhere/), 因此 README.md / package.json / docs/foo.md
// 这类裸相对路径也能识别。stem 校验在 isFileDownloadPath 里做, 排除 5.0 / 1.2.3 这种版本号噪音。
// 路径主干用 ASCII 路径字符严格白名单, 不放行中文 / 全宽标点 / @: 防止中文文本里夹杂 ASCII
// 触发起点后 greedy 扩展把整段中文框成 link。
const FILE_PATH_RE =
  /(?<![A-Za-z0-9:/])@?[A-Za-z0-9_./][A-Za-z0-9_./~%+,:=#-]*\.[A-Za-z0-9]{1,8}(?=[\s`"'<>),.;:!?,。；：！？、]|$)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

// 排除 5.0 / 1.2.3 / Mozilla/5.0 后段这种版本号噪音: 最末路径段去掉扩展后,
// 长度需 >= 2 且至少含一个字母/下划线/横线 (含 `-` 让 2026-05-10-spec.md 这种日期命名通过)。
// 显式前缀 (/ ./ ../ .dev-anywhere/) 是强路径信号, 直接通过, 不再做 stem 噪音过滤
// (避免误伤 /a.log / ./tmp/a.jpg 这类合法但单字母 stem 的路径)。
function isPlausibleFileNameStem(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith(".dev-anywhere/")
  ) {
    return true;
  }
  const stem = path.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const finalSegment = stem.split("/").pop() ?? stem;
  if (finalSegment.length < 2) return false;
  return /[A-Za-z_-]/.test(finalSegment);
}

export function isFileDownloadPath(value: string): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (IMAGE_EXT_RE.test(path)) return false;
  if (!FILE_EXT_RE.test(path)) return false;
  if (path.split("/").includes("...")) return false;
  return isPlausibleFileNameStem(path);
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
