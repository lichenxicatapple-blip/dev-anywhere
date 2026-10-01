import { findFileDownloadPathMatches } from "./file-download-path";
import { findMediaPreviewPathMatches } from "./media-preview-path";

export type InlinePathLinkKind = "file" | "image" | "video";

interface InlinePathLinkMatch {
  kind: InlinePathLinkKind;
  path: string;
  start: number;
  end: number;
}

export function findInlinePathLinks(text: string): InlinePathLinkMatch[] {
  const matches: InlinePathLinkMatch[] = findMediaPreviewPathMatches(text);
  for (const match of findFileDownloadPathMatches(text)) {
    const { start, end } = match;
    if (matches.some((existing) => start < existing.end && end > existing.start)) continue;
    matches.push({ kind: "file", ...match });
  }

  return matches.sort((a, b) => a.start - b.start);
}
