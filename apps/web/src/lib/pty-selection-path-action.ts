import { isScpLikeRemotePath } from "./scp-like-remote";
import { isRecognizedBareDomain } from "./bare-domain";

export type PtySelectionPathAction =
  | { kind: "image-preview"; path: string }
  | { kind: "file-download"; path: string };

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const FILE_EXT_RE = /\.[\p{L}\p{N}]{1,16}$/u;

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
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  if (isScpLikeRemotePath(path)) return null;
  if (path.split("/").includes("...")) return null;
  return path;
}

function isBareDomainLike(path: string): boolean {
  if (path.includes("/")) return false;
  return isRecognizedBareDomain(path);
}

function hasPlausibleStem(path: string): boolean {
  const finalPathSegment = path.split("/").pop() ?? path;
  if (/^\d+(?:\.\d+)+$/.test(finalPathSegment)) return false;
  if (path.includes("/")) return true;
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
