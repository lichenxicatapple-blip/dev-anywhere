// 起始字符放开 (不再要求 ./ / .. .dev-anywhere/), 让 PTY 输出里裸文件名 (shot.png) 也能预览。
import { isScpLikeRemotePath } from "./scp-like-remote";

// 负 lookbehind 防 URL 中段 / 路径中段被切。stem 校验排除 5.0 这类版本号噪音。
// lookahead 不接受 `.<字母数字>` 紧跟其后, 防 archive.png.bak 被截到 archive.png
// (image 扩展是固定白名单, 不存在双扩展场景, 比 file-download 更严格)。
// trailing `.` 仍允许 (句末标点), 由 trimPathToken 清理。
// 路径主干用 ASCII 路径字符严格白名单, 不放行中文 / 全宽标点 / @: 否则
// "中文@./...png" lazy 扩展会从中文 ASCII (logo) 起点啃到尾部 .png, 把整段框成 link。
const IMAGE_PATH_RE =
  /(?<![A-Za-z0-9@:/.-])@?(?:~\/|[A-Za-z0-9_./])[A-Za-z0-9_./~%+,:=#-]*?\.(?:png|jpe?g|webp|gif)(?=$|[\s`"'<>),;:!?，。；：！？、]|\.(?:$|[\s`"'<>),;:!?，。；：！？、]))/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

// 同 file-download-path: 显式前缀绕过 stem 校验, 避免误伤 /tmp/a.jpg 这种单字母 stem。
function isPlausibleFileNameStem(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    path.startsWith(".dev-anywhere/")
  ) {
    return true;
  }
  const stem = path.replace(/\.(?:png|jpe?g|webp|gif)$/i, "");
  const finalSegment = stem.split("/").pop() ?? stem;
  if (finalSegment.length < 2) return false;
  return /[A-Za-z_-]/.test(finalSegment);
}

export function isImagePreviewPath(value: string): boolean {
  const path = trimPathToken(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (isScpLikeRemotePath(path)) return false;
  if (!IMAGE_EXT_RE.test(path)) return false;
  return isPlausibleFileNameStem(path);
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
