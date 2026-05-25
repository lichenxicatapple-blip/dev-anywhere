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
  segments: FileDownloadPathSegment[];
};

type FileDownloadPathSegment = {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
};

type BufferTextPart = {
  lineNumber: number;
  sourceText: string;
  sourceStartIndex: number;
  text: string;
};

type BufferTextBlock = {
  startLineNumber: number;
  endLineNumber: number;
  parts: BufferTextPart[];
};

const MAX_WRAPPED_FILE_PATH_LINES = 16;
const MAX_SEMANTIC_FILE_PATH_BLOCKS = 8;
const DUPLICATE_ACTIVATION_WINDOW_MS = 750;
const SEMANTIC_PATH_START_RE =
  /(?:^|[\s([{@])@?(?:\/|\.\/|\.\.\/|~\/|\.dev-anywhere\/)[A-Za-z0-9_./~%+,:=#-]*$/;
const SEMANTIC_PATH_CONTINUATION_RE = /^[A-Za-z0-9_./~%+,:=#-]+$/;

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
  const blocks: BufferTextBlock[] = [
    getWrappedLineBlock(terminal, bufferLineNumber),
    ...getSemanticPathBlocksAroundLine(terminal, bufferLineNumber),
  ].filter((block): block is BufferTextBlock => block !== null);

  const seen = new Set<string>();
  return blocks.flatMap((block) => {
    const logicalLine = block.parts.map((part) => part.text).join("");
    return findFileDownloadPathSpans(logicalLine)
      .map((span) => {
        const start = stringIndexToTerminalPosition(block.parts, span.startIndex);
        const end = stringEndIndexToTerminalPosition(block.parts, span.endIndex);
        if (!start || !end) return null;
        return {
          path: span.path,
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
          segments: getPathSegmentsForSpan(block.parts, span.startIndex, span.endIndex),
        };
      })
      .filter((match): match is FileDownloadBufferPathMatch => match !== null)
      .filter(
        (match) =>
          bufferLineNumber >= match.startLineNumber && bufferLineNumber <= match.endLineNumber,
      )
      .filter((match) => {
        const key = `${match.path}:${match.startLineNumber}:${match.startColumn}:${match.endLineNumber}:${match.endColumn}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });
}

function getWrappedLineBlock(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): BufferTextBlock | null {
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

  return getWrappedLineBlockFromStart(terminal, startLineNumber, endLineNumber);
}

function getWrappedLineBlockFromStart(
  terminal: Pick<Terminal, "buffer">,
  startLineNumber: number,
  knownEndLineNumber?: number,
): BufferTextBlock | null {
  const active = terminal.buffer.active;
  let endLineNumber = knownEndLineNumber ?? startLineNumber;
  if (knownEndLineNumber === undefined) {
    for (let guard = 0; guard < MAX_WRAPPED_FILE_PATH_LINES; guard += 1) {
      const nextLine = active.getLine(endLineNumber);
      if (!nextLine?.isWrapped) break;
      endLineNumber += 1;
    }
  }

  const parts: BufferTextPart[] = [];
  for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
    const line = active.getLine(lineNumber - 1);
    if (!line) return null;
    const sourceText = line.translateToString(true);
    parts.push({
      lineNumber,
      sourceText,
      sourceStartIndex: 0,
      text: sourceText,
    });
  }
  return { startLineNumber, endLineNumber, parts };
}

function getSemanticPathBlocksAroundLine(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): BufferTextBlock[] {
  const active = terminal.buffer.active;
  const blocks: BufferTextBlock[] = [];
  const firstCandidate = Math.max(1, bufferLineNumber - MAX_WRAPPED_FILE_PATH_LINES);

  for (let lineNumber = firstCandidate; lineNumber <= bufferLineNumber; lineNumber += 1) {
    const line = active.getLine(lineNumber - 1);
    if (!line || line.isWrapped) continue;
    const block = getSemanticPathBlockFromStart(terminal, lineNumber);
    if (
      block &&
      bufferLineNumber >= block.startLineNumber &&
      bufferLineNumber <= block.endLineNumber
    ) {
      blocks.push(block);
    }
  }
  return blocks;
}

function getSemanticPathBlockFromStart(
  terminal: Pick<Terminal, "buffer">,
  startLineNumber: number,
): BufferTextBlock | null {
  const firstBlock = getWrappedLineBlockFromStart(terminal, startLineNumber);
  if (!firstBlock) return null;
  const firstText = firstBlock.parts.map((part) => part.text).join("");
  if (!SEMANTIC_PATH_START_RE.test(firstText)) return null;

  const parts = [...firstBlock.parts];
  let endLineNumber = firstBlock.endLineNumber;
  let hasContinuation = false;

  for (let guard = 0; guard < MAX_SEMANTIC_FILE_PATH_BLOCKS; guard += 1) {
    const nextStartLineNumber = endLineNumber + 1;
    const nextBlock = getWrappedLineBlockFromStart(terminal, nextStartLineNumber);
    if (!nextBlock) break;
    const firstPart = nextBlock.parts[0];
    if (!firstPart) break;
    const sourceStartIndex = countLeadingWhitespace(firstPart.sourceText);
    const text = firstPart.sourceText.slice(sourceStartIndex);
    if (!isSemanticPathContinuation(sourceStartIndex, text)) break;

    parts.push({
      ...firstPart,
      sourceStartIndex,
      text,
    });
    for (const wrappedPart of nextBlock.parts.slice(1)) {
      parts.push(wrappedPart);
    }
    hasContinuation = true;
    endLineNumber = nextBlock.endLineNumber;
  }

  if (!hasContinuation) return null;
  return { startLineNumber, endLineNumber, parts };
}

function countLeadingWhitespace(value: string): number {
  const match = value.match(/^\s*/);
  return match?.[0].length ?? 0;
}

function isSemanticPathContinuation(sourceStartIndex: number, text: string): boolean {
  if (sourceStartIndex < 2) return false;
  if (!text || text.startsWith("-") || text.startsWith("•") || text.startsWith("›")) return false;
  if (text.includes("://")) return false;
  return SEMANTIC_PATH_CONTINUATION_RE.test(text);
}

function stringIndexToTerminalPosition(
  parts: BufferTextPart[],
  index: number,
): { lineNumber: number; column: number } | null {
  let offset = index;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (offset < part.text.length) {
      return {
        lineNumber: part.lineNumber,
        column: stringToTerminalColumn(part.sourceText, part.sourceStartIndex + offset),
      };
    }
    if (offset === part.text.length && i < parts.length - 1) {
      const next = parts[i + 1];
      if (!next) return null;
      return {
        lineNumber: next.lineNumber,
        column: stringToTerminalColumn(next.sourceText, next.sourceStartIndex),
      };
    }
    offset -= part.text.length;
  }
  return null;
}

function stringEndIndexToTerminalPosition(
  parts: BufferTextPart[],
  exclusiveEndIndex: number,
): { lineNumber: number; column: number } | null {
  let offset = exclusiveEndIndex - 1;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (offset < part.text.length) {
      return {
        lineNumber: part.lineNumber,
        column: stringCellWidth(part.sourceText.slice(0, part.sourceStartIndex + offset + 1)),
      };
    }
    offset -= part.text.length;
  }
  return null;
}

function getPathSegmentsForSpan(
  parts: BufferTextPart[],
  startIndex: number,
  endIndex: number,
): FileDownloadPathSegment[] {
  const segments: FileDownloadPathSegment[] = [];
  let partStartIndex = 0;
  for (const part of parts) {
    const partEndIndex = partStartIndex + part.text.length;
    const overlapStart = Math.max(startIndex, partStartIndex);
    const overlapEnd = Math.min(endIndex, partEndIndex);
    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - partStartIndex;
      const localEnd = overlapEnd - partStartIndex;
      segments.push({
        lineNumber: part.lineNumber,
        startColumn: stringToTerminalColumn(part.sourceText, part.sourceStartIndex + localStart),
        endColumn: stringCellWidth(part.sourceText.slice(0, part.sourceStartIndex + localEnd)),
      });
    }
    partStartIndex = partEndIndex;
  }
  return segments;
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

function getRangesForPathMatch(match: FileDownloadBufferPathMatch): ILink["range"][] {
  if (match.segments.length > 0) {
    return match.segments.map((segment) => ({
      start: { x: segment.startColumn, y: segment.lineNumber },
      end: { x: segment.endColumn, y: segment.lineNumber },
    }));
  }
  return [
    {
      start: { x: match.startColumn, y: match.startLineNumber },
      end: { x: match.endColumn, y: match.endLineNumber },
    },
  ];
}

function shouldActivateDownload(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function registerFileDownloadLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols" | "element" | "registerLinkProvider" | "rows">,
  onDownload: (path: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  let lastActivation: { path: string; at: number } | null = null;

  const activateDownload = (path: string, event: MouseEvent): void => {
    if (!shouldActivateDownload(event)) return;
    const now = performance.now();
    if (lastActivation?.path === path && now - lastActivation.at < DUPLICATE_ACTIVATION_WINDOW_MS) {
      return;
    }
    lastActivation = { path, at: now };
    onDownload(path);
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const matches = findFileDownloadPathMatchesInWrappedBuffer(terminal, bufferLineNumber);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links = matches.reduce<ILink[]>((acc, match) => {
        for (const range of getRangesForPathMatch(match)) {
          if (range.start.y !== bufferLineNumber || range.end.y !== bufferLineNumber) continue;
          acc.push({
            text: match.path,
            range,
            decorations: {
              underline: false,
              pointerCursor: true,
            },
            hover: () => {
              renderPathHoverSegments(terminal, match);
            },
            leave: () => {
              clearPathHoverSegments(terminal);
            },
            dispose: () => {
              clearPathHoverSegments(terminal);
            },
            // 桌面仍要求 cmd/ctrl + click 防误触。移动端下载走长按选区 toolbar,
            // tap 文件路径只用于命中/选区候选, 不直接拉取文件。
            activate: (event) => {
              activateDownload(match.path, event);
            },
          });
        }
        return acc;
      }, []);
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = terminal.registerLinkProvider(provider);
  return {
    dispose: () => {
      clearPathHoverSegments(terminal);
      disposable.dispose();
    },
    provider,
  };
}

function renderPathHoverSegments(
  terminal: Pick<Terminal, "buffer" | "cols" | "element" | "rows">,
  match: FileDownloadBufferPathMatch,
): void {
  const element = terminal.element;
  if (!element) return;
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return;
  const elementRect = element.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const cellW = (screen.clientWidth || screenRect.width) / terminal.cols;
  const cellH = (screen.clientHeight || screenRect.height) / terminal.rows;
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return;

  clearPathHoverSegments(terminal);
  ensureOverlayPositioning(element);

  const overlay = document.createElement("div");
  overlay.dataset.slot = "pty-file-link-hover-overlay";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "4";
  element.append(overlay);

  const screenLeft = screenRect.left - elementRect.left;
  const screenTop = screenRect.top - elementRect.top;
  const viewportY = terminal.buffer.active.viewportY;

  for (const segment of match.segments) {
    const viewportRow = segment.lineNumber - viewportY;
    if (viewportRow < 1 || viewportRow > terminal.rows) continue;
    const underline = document.createElement("div");
    underline.dataset.slot = "pty-file-link-hover-segment";
    underline.dataset.range = `${segment.lineNumber}:${segment.startColumn}-${segment.endColumn}`;
    underline.style.position = "absolute";
    underline.style.left = `${screenLeft + (segment.startColumn - 1) * cellW}px`;
    underline.style.top = `${screenTop + (viewportRow - 1) * cellH + cellH - 2}px`;
    underline.style.width = `${Math.max(1, segment.endColumn - segment.startColumn + 1) * cellW}px`;
    underline.style.height = "2px";
    underline.style.background = "currentColor";
    underline.style.opacity = "0.8";
    overlay.append(underline);
  }
}

function clearPathHoverSegments(terminal: Pick<Terminal, "element">): void {
  terminal.element
    ?.querySelectorAll('[data-slot="pty-file-link-hover-overlay"]')
    .forEach((node) => node.remove());
}

function ensureOverlayPositioning(element: HTMLElement): void {
  const style = window.getComputedStyle(element);
  if (style.position !== "static") return;
  element.style.position = "relative";
}
