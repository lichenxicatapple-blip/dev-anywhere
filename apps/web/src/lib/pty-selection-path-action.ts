import { isScpLikeRemotePath } from "./scp-like-remote";

export type PtySelectionPathAction =
  | { kind: "image-preview"; path: string }
  | { kind: "file-download"; path: string };

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const DOMAIN_TLD_RE =
  /^(?:com|net|org|io|dev|app|top|cn|ai|co|me|xyz|site|online|cloud|tools|tech|info|biz|us|uk|de|jp|fr|ru|nl|in)$/i;

function normalizeSelectionToken(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

function getSingleSelectedPath(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  const path = normalizeSelectionToken(trimmed);
  if (!path || /\s/.test(path)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  if (isScpLikeRemotePath(path)) return null;
  if (path.split("/").includes("...")) return null;
  return path;
}

function isBareDomainLike(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    path.startsWith(".dev-anywhere/") ||
    path.includes("/")
  ) {
    return false;
  }

  const labels = path.split(".");
  if (labels.length < 2) return false;
  const tld = labels.at(-1) ?? "";
  if (!DOMAIN_TLD_RE.test(tld)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function hasPlausibleStem(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    path.startsWith(".dev-anywhere/")
  ) {
    return true;
  }
  const stem = path.replace(FILE_EXT_RE, "");
  const finalSegment = stem.split("/").pop() ?? stem;
  return /[A-Za-z_-]/.test(finalSegment);
}

export function resolvePtySelectionPathAction(text: string): PtySelectionPathAction | null {
  const path = getSingleSelectedPath(text);
  if (!path || isBareDomainLike(path) || !hasPlausibleStem(path)) return null;

  if (IMAGE_EXT_RE.test(path)) return { kind: "image-preview", path };
  if (FILE_EXT_RE.test(path)) return { kind: "file-download", path };

  return null;
}
