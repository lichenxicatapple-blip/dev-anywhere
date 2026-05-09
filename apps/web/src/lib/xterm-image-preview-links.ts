import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { extractImagePreviewPaths } from "./image-preview-path";

type ImagePreviewPathMatch = {
  path: string;
  startColumn: number;
  endColumn: number;
};

export function findImagePreviewPathMatches(line: string): ImagePreviewPathMatch[] {
  const paths = extractImagePreviewPaths(line);
  const matches: ImagePreviewPathMatch[] = [];
  let searchFrom = 0;
  for (const path of paths) {
    const rawIndex = line.indexOf(path, searchFrom);
    const atIndex = rawIndex > 0 && line[rawIndex - 1] === "@" ? rawIndex - 1 : rawIndex;
    if (rawIndex < 0) continue;
    matches.push({
      path,
      startColumn: atIndex + 1,
      endColumn: rawIndex + path.length,
    });
    searchFrom = rawIndex + path.length;
  }
  return matches;
}

export function registerImagePreviewLinkProvider(
  terminal: Pick<Terminal, "buffer" | "registerLinkProvider">,
  onPreview: (path: string) => void,
): { dispose: () => void } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
      if (!line) {
        callback(undefined);
        return;
      }
      const links: ILink[] = findImagePreviewPathMatches(line).map((match) => ({
        text: match.path,
        range: {
          start: { x: match.startColumn, y: bufferLineNumber },
          end: { x: match.endColumn, y: bufferLineNumber },
        },
        decorations: {
          underline: true,
          pointerCursor: true,
        },
        activate: () => onPreview(match.path),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
  return terminal.registerLinkProvider(provider);
}
