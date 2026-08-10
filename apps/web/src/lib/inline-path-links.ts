import { findFileDownloadPathMatches } from "./file-download-path";
import { findImagePreviewPathMatches } from "./image-preview-path";

export type InlinePathLinkKind = "file" | "image";

interface InlinePathLinkMatch {
  kind: InlinePathLinkKind;
  path: string;
  start: number;
  end: number;
}

export function findInlinePathLinks(text: string): InlinePathLinkMatch[] {
  const matches: InlinePathLinkMatch[] = findImagePreviewPathMatches(text).map((match) => ({
    kind: "image",
    ...match,
  }));
  for (const match of findFileDownloadPathMatches(text)) {
    const { start, end } = match;
    if (matches.some((existing) => start < existing.end && end > existing.start)) continue;
    matches.push({ kind: "file", ...match });
  }

  return matches.sort((a, b) => a.start - b.start);
}
