import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { extractFileDownloadPaths } from "./file-download-path";

type FileDownloadPathMatch = {
  path: string;
  startColumn: number;
  endColumn: number;
};

type FileDownloadPathSpan = {
  path: string;
  startIndex: number;
  endIndex: number;
};

type FileDownloadBufferPathMatch = {
  path: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

const MAX_WRAPPED_FILE_PATH_LINES = 16;

export function findFileDownloadPathMatches(line: string): FileDownloadPathMatch[] {
  return findFileDownloadPathSpans(line).map((span) => ({
    path: span.path,
    startColumn: stringToTerminalColumn(line, span.startIndex),
    endColumn: stringCellWidth(line.slice(0, span.endIndex)),
  }));
}

function findFileDownloadPathSpans(line: string): FileDownloadPathSpan[] {
  const paths = extractFileDownloadPaths(line);
  const matches: FileDownloadPathSpan[] = [];
  let searchFrom = 0;
  for (const path of paths) {
    const rawIndex = line.indexOf(path, searchFrom);
    if (rawIndex < 0) continue;
    const atIndex = rawIndex > 0 && line[rawIndex - 1] === "@" ? rawIndex - 1 : rawIndex;
    const endIndex = rawIndex + path.length;
    matches.push({
      path,
      startIndex: atIndex,
      endIndex,
    });
    searchFrom = rawIndex + path.length;
  }
  return matches;
}

export function findFileDownloadPathMatchesInWrappedBuffer(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): FileDownloadBufferPathMatch[] {
  const block = getWrappedLineBlock(terminal, bufferLineNumber);
  if (!block) return [];

  const logicalLine = block.parts.join("");
  return findFileDownloadPathSpans(logicalLine)
    .map((span) => {
      const start = stringIndexToTerminalPosition(
        block.parts,
        block.startLineNumber,
        span.startIndex,
      );
      const end = stringEndIndexToTerminalPosition(
        block.parts,
        block.startLineNumber,
        span.endIndex,
      );
      if (!start || !end) return null;
      return {
        path: span.path,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    })
    .filter((match): match is FileDownloadBufferPathMatch => match !== null)
    .filter(
      (match) =>
        bufferLineNumber >= match.startLineNumber && bufferLineNumber <= match.endLineNumber,
    );
}

function getWrappedLineBlock(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): { startLineNumber: number; parts: string[] } | null {
  const active = terminal.buffer.active;
  let startLineNumber = bufferLineNumber;
  let endLineNumber = bufferLineNumber;
  for (let guard = 0; guard < MAX_WRAPPED_FILE_PATH_LINES; guard += 1) {
    const line = active.getLine(startLineNumber - 1);
    if (!line?.isWrapped || startLineNumber <= 1) break;
    startLineNumber -= 1;
  }
  for (let guard = 0; guard < MAX_WRAPPED_FILE_PATH_LINES; guard += 1) {
    const nextLine = active.getLine(endLineNumber);
    if (!nextLine?.isWrapped) break;
    endLineNumber += 1;
  }

  const parts: string[] = [];
  for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
    const line = active.getLine(lineNumber - 1);
    if (!line) return null;
    parts.push(line.translateToString(true));
  }
  return { startLineNumber, parts };
}

function stringIndexToTerminalPosition(
  parts: string[],
  startLineNumber: number,
  index: number,
): { lineNumber: number; column: number } | null {
  let offset = index;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (offset < part.length) {
      return {
        lineNumber: startLineNumber + i,
        column: stringToTerminalColumn(part, offset),
      };
    }
    if (offset === part.length && i < parts.length - 1) {
      return { lineNumber: startLineNumber + i + 1, column: 1 };
    }
    offset -= part.length;
  }
  return null;
}

function stringEndIndexToTerminalPosition(
  parts: string[],
  startLineNumber: number,
  exclusiveEndIndex: number,
): { lineNumber: number; column: number } | null {
  let offset = exclusiveEndIndex - 1;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (offset < part.length) {
      return {
        lineNumber: startLineNumber + i,
        column: stringCellWidth(part.slice(0, offset + 1)),
      };
    }
    offset -= part.length;
  }
  return null;
}

function stringToTerminalColumn(line: string, endIndex: number): number {
  return stringCellWidth(line.slice(0, endIndex)) + 1;
}

function stringCellWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += codePointCellWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function codePointCellWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningCodePoint(codePoint)) return 0;
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function getLineRangeForPathMatch(
  match: FileDownloadBufferPathMatch,
  bufferLineNumber: number,
  cols: number,
): ILink["range"] | null {
  if (bufferLineNumber < match.startLineNumber || bufferLineNumber > match.endLineNumber) {
    return null;
  }
  const startColumn = bufferLineNumber === match.startLineNumber ? match.startColumn : 1;
  const endColumn = bufferLineNumber === match.endLineNumber ? match.endColumn : cols;
  if (endColumn < startColumn) return null;
  return {
    start: { x: startColumn, y: bufferLineNumber },
    end: { x: endColumn, y: bufferLineNumber },
  };
}

function shouldActivateDownload(event: MouseEvent): boolean {
  if (event.metaKey || event.ctrlKey) return true;
  const pointerType =
    "pointerType" in event
      ? String((event as MouseEvent & { pointerType?: unknown }).pointerType)
      : "";
  if (pointerType === "touch" || pointerType === "pen") return true;
  return window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
}

export function registerFileDownloadLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols" | "registerLinkProvider">,
  onDownload: (path: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const matches = findFileDownloadPathMatchesInWrappedBuffer(terminal, bufferLineNumber);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links = matches.reduce<ILink[]>((acc, match) => {
        const range = getLineRangeForPathMatch(match, bufferLineNumber, terminal.cols);
        if (!range) return acc;
        acc.push({
          text: match.path,
          range,
          decorations: {
            underline: true,
            pointerCursor: true,
          },
          // 桌面仍要求 cmd/ctrl + click 防误触；触屏设备上用户没有修饰键,
          // 点击已高亮的文件路径就是下载意图。
          activate: (event) => {
            if (!shouldActivateDownload(event)) return;
            onDownload(match.path);
          },
        });
        return acc;
      }, []);
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = terminal.registerLinkProvider(provider);
  return { dispose: () => disposable.dispose(), provider };
}
