// 起始字符放开（不强制路径前缀），让 PTY 输出里的裸文件名（shot.png）也能预览。
import { isScpLikeRemotePath } from "./scp-like-remote";

// 负 lookbehind 防 URL 中段 / 路径中段被切。stem 校验排除 5.0 这类版本号噪音。
// lookahead 不接受 `.<字母数字>` 紧跟其后, 防 archive.png.bak 被截到 archive.png
// (媒体扩展是固定白名单, 不存在双扩展场景, 比 file-download 更严格)。
// trailing `.` 仍允许 (句末标点), 由 trimPathToken 清理。
// 路径主干用 ASCII 路径字符严格白名单, 不放行中文 / 全宽标点 / @: 否则
// "中文@./...png" lazy 扩展会从中文 ASCII (logo) 起点啃到尾部 .png, 把整段框成 link。
const MEDIA_PATH_RE =
  /(?<![\p{L}\p{N}@:/.-])(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|ogv)(?=$|[\s`"'<>),;:!?，。；：！？、]|\.(?:$|[\s`"'<>),;:!?，。；：！？、]))/giu;
const EXPLICIT_MEDIA_PATH_RE =
  /(?<![A-Za-z0-9._+-])@(?:~\/|[^\s`"'<>，。；：！？、@])[^\s`"'<>，。；：！？、@]*?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|ogv)(?=$|[\s`"'<>),;:!?，。；：！？、]|\.(?:$|[\s`"'<>),;:!?，。；：！？、]))/giu;
const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|ogv)$/i;

export type MediaPreviewKind = "image" | "video";

interface MediaPreviewPathMatch {
  kind: MediaPreviewKind;
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
  if (/[\\/]/.test(path)) return true;
  const stem = path.replace(MEDIA_EXT_RE, "");
  const finalSegment = stem.split(/[\\/]/).pop() ?? stem;
  if (finalSegment.length < 2) return false;
  return /[\p{L}_-]/u.test(finalSegment);
}

export function getMediaPreviewKind(value: string): MediaPreviewKind | null {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || isScpLikeRemotePath(path)) return null;
  if (!MEDIA_EXT_RE.test(path)) return null;
  return /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(path) ? "video" : "image";
}

export function isMediaPreviewPath(value: string): boolean {
  const path = trimPathToken(value);
  if (!getMediaPreviewKind(path)) return false;
  return isPlausibleFileNameStem(path);
}

export function findMediaPreviewPathMatches(text: string): MediaPreviewPathMatch[] {
  const matches: MediaPreviewPathMatch[] = [];
  for (const pattern of [EXPLICIT_MEDIA_PATH_RE, MEDIA_PATH_RE]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0] ?? "";
      const start = match.index ?? -1;
      if (start < 0) continue;
      const end = start + raw.length;
      // Explicit @ paths take precedence over suffixes recognized inside Windows/home paths.
      if (matches.some((existing) => start < existing.end && end > existing.start)) continue;
      const path = trimPathToken(raw);
      const kind = getMediaPreviewKind(path);
      if (!kind || !isPlausibleFileNameStem(path)) continue;
      matches.push({ kind, path, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function extractMediaPreviewPaths(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { path } of findMediaPreviewPathMatches(text)) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
