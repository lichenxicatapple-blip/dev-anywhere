import { isFileDownloadPath } from "./file-download-path";
import { isImagePreviewPath } from "./image-preview-path";

export type InlinePathLinkKind = "file" | "image";

interface InlinePathLinkMatch {
  kind: InlinePathLinkKind;
  path: string;
  start: number;
  end: number;
}

const PATH_TOKEN_RE =
  /(?<![A-Za-z0-9@:/.-])@?[A-Za-z0-9_./][A-Za-z0-9_./~%+,:=#-]*\.[A-Za-z0-9]{1,8}(?=[\s`"'<>),.;:!?,。；：！？、]|$)/gi;

function trimPathToken(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/^[([{]+/, "")
    .replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

export function findInlinePathLinks(text: string): InlinePathLinkMatch[] {
  const matches: InlinePathLinkMatch[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? -1;
    if (start < 0) continue;

    const path = trimPathToken(raw);
    const kind = isImagePreviewPath(path) ? "image" : isFileDownloadPath(path) ? "file" : null;
    if (!kind) continue;

    const key = `${kind}:${path}:${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind, path, start, end: start + raw.length });
  }

  return matches;
}
