// 任意文件下载路径提取: 与 image-preview-path 形状对称, 但排除图片扩展, 让两条 link provider
// 在同一行不会双重 underline。要求必有扩展 (避免误把纯目录如 /Users 当文件链接)。
import { isScpLikeRemotePath } from "./scp-like-remote";
import { isRecognizedBareDomain } from "./bare-domain";

// 负 lookbehind 防止匹配 URL (https://... 里的 //example...) 或路径中段 (a/b/c.txt 不该从 b 切)。
// 路径主干用 greedy `*` 而非 lazy `*?`: 双扩展 (.tar.gz / .min.js / .d.ts) 在 lazy 下只会匹配
// 到第一个扩展段 (`.tar`) 即停止。greedy 模式下延伸到下一空白前, 扩展子表达式
// `\.[A-Za-z0-9]{1,8}` 回溯到最末段, 支持任意层数扩展。
// 起始字符放开（不强制路径前缀），让 docs/foo.md 这类相对路径
// 以及少量约定俗成的顶层项目文件名能识别。具体“是否像路径”不在 regex 层猜,
// 统一由 isFileDownloadPath 按强路径信号判断；最终是否真实存在由 proxy 按 session cwd
// 做 metadata 预检。
// 路径主干用 ASCII 路径字符严格白名单, 不放行中文 / 全宽标点 / @: 防止中文文本里夹杂 ASCII
// 触发起点后 greedy 扩展把整段中文框成 link。
const FILE_PATH_RE =
  /(?<![\p{L}\p{N}@:/.-])(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*\.[\p{L}\p{N}]{1,16}(?=[\s`"'<>),.;:!?,。；：！？、]|$)/giu;
const EXPLICIT_FILE_PATH_RE =
  /(?<![A-Za-z0-9._+-])@(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*\.[\p{L}\p{N}]{1,16}(?=[\s`"'<>),.;:!?,。；：！？、]|$)/giu;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_EXT_RE = /\.[\p{L}\p{N}]{1,16}$/u;
const KNOWN_TOP_LEVEL_FILE_NAMES = new Set([
  "cargo.toml",
  "composer.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "prettier.config.js",
  "pyproject.toml",
  "readme.md",
  "requirements.txt",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "yarn.lock",
]);

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

// 排除 5.0 / 1.2.3 / Mozilla/5.0 后段这种版本号噪音: 最末路径段去掉扩展后,
// 长度需 >= 2 且至少含一个字母/下划线/横线 (含 `-` 让 2026-05-10-spec.md 这种日期命名通过)。
// 目录分隔符是强路径信号, 直接通过, 不再做 stem 噪音过滤
// (避免误伤 /a.log / ./tmp/a.jpg 这类合法但单字母 stem 的路径)。
function isPlausibleFileNameStem(path: string): boolean {
  const finalPathSegment = path.split("/").pop() ?? path;
  if (/^\d+(?:\.\d+)+$/.test(finalPathSegment)) return false;
  if (path.includes("/")) return true;
  const stem = path.replace(/\.[\p{L}\p{N}]{1,16}$/u, "");
  const finalSegment = stem.split("/").pop() ?? stem;
  if (finalSegment.length < 2) return false;
  return /[\p{L}_-]/u.test(finalSegment);
}

function isBareDomainLike(path: string): boolean {
  if (path.includes("/")) return false;
  return isRecognizedBareDomain(path);
}

function hasExplicitPathSignal(path: string): boolean {
  return path.includes("/");
}

function hasPathSignal(path: string, allowBare: boolean): boolean {
  if (hasExplicitPathSignal(path)) return true;
  if (allowBare) return true;
  return KNOWN_TOP_LEVEL_FILE_NAMES.has(path.toLowerCase());
}

export function isFileDownloadPath(value: string, options: { allowBare?: boolean } = {}): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (isScpLikeRemotePath(path)) return false;
  if (!options.allowBare && isBareDomainLike(path)) return false;
  if (IMAGE_EXT_RE.test(path)) return false;
  if (!FILE_EXT_RE.test(path)) return false;
  if (!hasPathSignal(path, options.allowBare === true)) return false;
  if (path.split("/").includes("...")) return false;
  return isPlausibleFileNameStem(path);
}

interface FileDownloadPathMatch {
  path: string;
  start: number;
  end: number;
}

export function findFileDownloadPathMatches(text: string): FileDownloadPathMatch[] {
  const matches: FileDownloadPathMatch[] = [];
  for (const pattern of [EXPLICIT_FILE_PATH_RE, FILE_PATH_RE]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0] ?? "";
      const start = match.index ?? -1;
      if (start < 0) continue;
      const path = trimPathToken(raw);
      if (!isFileDownloadPath(path, { allowBare: raw.startsWith("@") })) continue;
      matches.push({ path, start, end: start + raw.length });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function extractFileDownloadPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { path } of findFileDownloadPathMatches(text)) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
