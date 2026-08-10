// 起始字符放开（不强制路径前缀），让 PTY 输出里的裸文件名（shot.png）也能预览。
import { isScpLikeRemotePath } from "./scp-like-remote";

// 负 lookbehind 防 URL 中段 / 路径中段被切。stem 校验排除 5.0 这类版本号噪音。
// lookahead 不接受 `.<字母数字>` 紧跟其后, 防 archive.png.bak 被截到 archive.png
// (image 扩展是固定白名单, 不存在双扩展场景, 比 file-download 更严格)。
// trailing `.` 仍允许 (句末标点), 由 trimPathToken 清理。
// 路径主干用 ASCII 路径字符严格白名单, 不放行中文 / 全宽标点 / @: 否则
// "中文@./...png" lazy 扩展会从中文 ASCII (logo) 起点啃到尾部 .png, 把整段框成 link。
const IMAGE_PATH_RE =
  /(?<![\p{L}\p{N}@:/.-])(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif)(?=$|[\s`"'<>),;:!?，。；：！？、]|\.(?:$|[\s`"'<>),;:!?，。；：！？、]))/giu;
const EXPLICIT_IMAGE_PATH_RE =
  /(?<![A-Za-z0-9._+-])@(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif)(?=$|[\s`"'<>),;:!?，。；：！？、]|\.(?:$|[\s`"'<>),;:!?，。；：！？、]))/giu;
// 空格只有在路径具备明确边界时才放行：绝对/点相对/home 路径，
// 或至少包含一个目录段。裸 `final shot.png` 无法与普通句子可靠区分，调用方应使用
// @ 或 Markdown link 明确边界。
const SPACED_IMAGE_PATH_RE =
  /(?<![\p{L}\p{N}@:/.-])(?:~\/|\.{1,2}\/|\/|[^\s`"'<>，。；：！？、/@]+\/)[^\n\r\t`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif)(?=$|[\s`"'<>),;:!?，。；：！？、])/giu;
const EXPLICIT_SPACED_IMAGE_PATH_RE =
  /(?<![A-Za-z0-9._+-])@(?:~\/|[^\s`"'<>，。；：！？、@])[^\n\r\t`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif)(?=$|[\s`"'<>),;:!?，。；：！？、])/giu;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

export interface ImagePreviewPathMatch {
  path: string;
  start: number;
  end: number;
}

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

// 同 file-download-path: 显式前缀绕过 stem 校验, 避免误伤 /tmp/a.jpg 这种单字母 stem。
function isPlausibleFileNameStem(path: string): boolean {
  if (path.includes("/")) return true;
  const stem = path.replace(/\.(?:png|jpe?g|webp|gif)$/i, "");
  const finalSegment = stem.split("/").pop() ?? stem;
  if (finalSegment.length < 2) return false;
  return /[\p{L}_-]/u.test(finalSegment);
}

export function isImagePreviewPath(value: string): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (isScpLikeRemotePath(path)) return false;
  if (!IMAGE_EXT_RE.test(path)) return false;
  return isPlausibleFileNameStem(path);
}

export function findImagePreviewPathMatches(text: string): ImagePreviewPathMatch[] {
  const candidates: ImagePreviewPathMatch[] = [];
  for (const pattern of [
    EXPLICIT_SPACED_IMAGE_PATH_RE,
    SPACED_IMAGE_PATH_RE,
    EXPLICIT_IMAGE_PATH_RE,
    IMAGE_PATH_RE,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0] ?? "";
      const start = match.index ?? -1;
      if (start < 0) continue;
      const path = trimPathToken(raw);
      if (!isImagePreviewPath(path)) continue;
      candidates.push({ path, start, end: start + raw.length });
    }
  }

  // The token regex can also find the tail of a spaced path. Prefer the earliest,
  // longest candidate and discard overlapping partial matches.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const matches: ImagePreviewPathMatch[] = [];
  for (const candidate of candidates) {
    if (matches.some((match) => candidate.start < match.end && candidate.end > match.start)) {
      continue;
    }
    matches.push(candidate);
  }
  return matches;
}

export function extractImagePreviewPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { path } of findImagePreviewPathMatches(text)) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
