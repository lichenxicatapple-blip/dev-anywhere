import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { XtermBufferPathMatch } from "./xterm-wrapped-path-matches";

type XtermOscLinkInternals = {
  _core?: { _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined } };
};

// xterm 6 stores OSC 8 IDs on cells and exposes their destinations through an internal service.
export function getXtermOscLinkId(cell: IBufferCell | undefined): number | undefined {
  const attributes = cell as
    | (IBufferCell & { extended?: { urlId?: number }; hasExtendedAttrs?: () => number })
    | undefined;
  if (attributes?.hasExtendedAttrs?.() === 0) return undefined;
  return attributes?.extended?.urlId;
}

function decodeLocalFileUri(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || url.hostname || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    if (Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      return null;
    }
    if (path.startsWith("//") || !path.startsWith("/")) return null;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

export function findXtermOscFilePathMatches(
  terminal: Pick<Terminal, "buffer">,
  lineNumber: number,
): XtermBufferPathMatch[] {
  const service = (terminal as XtermOscLinkInternals)._core?._oscLinkService;
  const line = terminal.buffer.active.getLine(lineNumber - 1);
  if (!service || !line) return [];

  const matches: XtermBufferPathMatch[] = [];
  let lastUri: string | undefined;
  let activeMatch: XtermBufferPathMatch | undefined;
  let cell: IBufferCell | undefined;
  for (let column = 0; column < line.length; column += 1) {
    cell = line.getCell(column, cell);
    if (cell?.getWidth() === 0) continue;
    const id = getXtermOscLinkId(cell);
    const uri = cell?.getChars() && id ? service.getLinkData(id)?.uri : undefined;
    if (uri !== lastUri) {
      activeMatch = undefined;
      lastUri = uri;
      const path = uri && decodeLocalFileUri(uri);
      if (path) {
        activeMatch = {
          path,
          startLineNumber: lineNumber,
          endLineNumber: lineNumber,
          startColumn: column + 1,
          endColumn: column + 1,
          segments: [{ lineNumber, startColumn: column + 1, endColumn: column + 1 }],
        };
        matches.push(activeMatch);
      }
    }
    if (activeMatch && cell) {
      activeMatch.endColumn = column + cell.getWidth();
      activeMatch.segments[0].endColumn = activeMatch.endColumn;
    }
  }
  return matches;
}
