import type { Terminal } from "@xterm/xterm";
import { measureXtermCellSize } from "./pty-xterm-metrics";
import type { PtySelectionPathAction } from "./pty-selection-path-action";
import { findFileDownloadPathMatchesInWrappedBuffer } from "./xterm-file-download-links";
import { findImagePreviewPathMatchesInWrappedBuffer } from "./xterm-image-preview-links";

export interface TerminalSelectionPoint {
  row: number;
  column: number;
}

interface TerminalSelectionResult {
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
  text: string;
}

interface TerminalPathSelectionResult extends TerminalSelectionResult {
  pathAction: PtySelectionPathAction;
}

interface TerminalPointAtClientOptions {
  terminal: Terminal;
  host: HTMLElement;
  clientX: number;
  clientY: number;
  cellWidth?: number;
  cellHeight?: number;
}

type SelectTerminalLineAtPointOptions = TerminalPointAtClientOptions;

type SelectTerminalTokenAtPointOptions = TerminalPointAtClientOptions;

type SelectTerminalInitialRangeAtPointOptions = TerminalPointAtClientOptions;

interface SelectTerminalInitialRangeAtBufferPointOptions {
  terminal: Terminal;
  point: TerminalSelectionPoint;
}

type SelectTerminalPathLinkAtBufferPointOptions = SelectTerminalInitialRangeAtBufferPointOptions;

interface SelectTerminalRangeOptions {
  terminal: Terminal;
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
}

interface TerminalPointClientPositionOptions {
  terminal: Terminal;
  host: HTMLElement;
  point: TerminalSelectionPoint;
  affinity?: "before" | "after";
  cellWidth?: number;
  cellHeight?: number;
}

interface TerminalLineTextCellSpan {
  textStart: number;
  textEnd: number;
  cellStart: number;
  cellEnd: number;
}

interface TerminalLineTextRange {
  start: number;
  end: number;
}

const terminalWordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const TECHNICAL_TOKEN_CONNECTOR_PATTERN = /^[./:@_+~=-]+$/u;
const ASCII_WORD_PATTERN = /[a-z0-9]/iu;

function getCellSize({
  terminal,
  host,
  cellWidth,
  cellHeight,
}: Pick<TerminalPointAtClientOptions, "terminal" | "host" | "cellWidth" | "cellHeight">): {
  cellW: number;
  cellH: number;
} | null {
  if (cellWidth && cellHeight) return { cellW: cellWidth, cellH: cellHeight };
  return measureXtermCellSize(host, terminal);
}

function findNonBlankCellRange(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  maxCols: number,
): { start: number; end: number } | null {
  const endLimit = Math.min(line.length, maxCols);
  const hasVisibleChars = (index: number): boolean =>
    (line.getCell(index)?.getChars() ?? "").trim().length > 0;
  let start = 0;
  while (start < endLimit && !hasVisibleChars(start)) start += 1;
  if (start >= endLimit) return null;

  let end = endLimit - 1;
  while (end >= start && !hasVisibleChars(end)) end -= 1;
  if (end < start) return null;

  return { start, end };
}

function findTokenCellRange(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  column: number,
  maxCols: number,
): { start: number; end: number } | null {
  const endLimit = Math.min(line.length, maxCols);
  if (column < 0 || column >= endLimit) return null;

  if (!hasVisibleChars(line, column)) return null;

  let start = column;
  while (start > 0 && hasVisibleChars(line, start - 1)) start -= 1;

  let end = column;
  while (end + 1 < endLimit && hasVisibleChars(line, end + 1)) end += 1;

  return { start, end };
}

function hasVisibleChars(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  index: number,
): boolean {
  return (line.getCell(index)?.getChars() ?? "").trim().length > 0;
}

function getTerminalLineTextAndCellSpans(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  maxCols: number,
): { text: string; spans: TerminalLineTextCellSpan[] } {
  const endLimit = Math.min(line.length, maxCols);
  const spans: TerminalLineTextCellSpan[] = [];
  let text = "";

  for (let column = 0; column < endLimit; column += 1) {
    const cell = line.getCell(column);
    const width = cell?.getWidth() ?? 1;
    if (width === 0) continue;

    const chars = cell?.getChars() || " ";
    const textStart = text.length;
    text += chars;
    spans.push({
      textStart,
      textEnd: text.length,
      cellStart: column,
      cellEnd: Math.min(endLimit - 1, column + Math.max(1, width) - 1),
    });
  }

  return { text: text.trimEnd(), spans };
}

function isTechnicalConnector(segment: Intl.SegmentData): boolean {
  return TECHNICAL_TOKEN_CONNECTOR_PATTERN.test(segment.segment);
}

function isAsciiWord(segment: Intl.SegmentData): boolean {
  return segment.isWordLike === true && ASCII_WORD_PATTERN.test(segment.segment);
}

// Preserve terminal identifiers that Intl.Segmenter splits around connector punctuation.
function expandTechnicalTextRange(
  segments: Intl.SegmentData[],
  wordIndex: number,
): TerminalLineTextRange {
  let startIndex = wordIndex;
  let endIndex = wordIndex;

  while (startIndex > 0) {
    let connectorIndex = startIndex - 1;
    while (connectorIndex >= 0 && isTechnicalConnector(segments[connectorIndex])) {
      connectorIndex -= 1;
    }
    if (connectorIndex === startIndex - 1) break;
    if (connectorIndex >= 0 && isAsciiWord(segments[connectorIndex])) {
      startIndex = connectorIndex;
      continue;
    }
    startIndex = connectorIndex + 1;
    break;
  }

  while (endIndex + 1 < segments.length) {
    let connectorIndex = endIndex + 1;
    while (connectorIndex < segments.length && isTechnicalConnector(segments[connectorIndex])) {
      connectorIndex += 1;
    }
    if (
      connectorIndex === endIndex + 1 ||
      connectorIndex >= segments.length ||
      !isAsciiWord(segments[connectorIndex])
    ) {
      break;
    }
    endIndex = connectorIndex;
  }

  const start = segments[startIndex].index;
  const last = segments[endIndex];
  return { start, end: last.index + last.segment.length };
}

function findSemanticTextRanges(text: string): TerminalLineTextRange[] {
  const segments = Array.from(terminalWordSegmenter.segment(text));
  const ranges: TerminalLineTextRange[] = [];
  const seen = new Set<string>();

  const addRange = (range: TerminalLineTextRange): void => {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push(range);
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.isWordLike) continue;
    addRange(
      isAsciiWord(segment)
        ? expandTechnicalTextRange(segments, index)
        : { start: segment.index, end: segment.index + segment.segment.length },
    );
  }

  for (const segment of segments) {
    if (segment.isWordLike || !segment.segment.trim()) continue;
    const range = { start: segment.index, end: segment.index + segment.segment.length };
    if (!ranges.some((candidate) => candidate.start <= range.start && candidate.end >= range.end)) {
      addRange(range);
    }
  }

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function findSemanticTokenCellRanges(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  maxCols: number,
): Array<{ start: number; end: number }> {
  const { text, spans } = getTerminalLineTextAndCellSpans(line, maxCols);
  return findSemanticTextRanges(text).flatMap((range) => {
    const covered = spans.filter(
      (span) => span.textStart < range.end && span.textEnd > range.start,
    );
    const first = covered[0];
    const last = covered.at(-1);
    return first && last ? [{ start: first.cellStart, end: last.cellEnd }] : [];
  });
}

function findNearestTokenIndex(
  ranges: Array<{ start: number; end: number }>,
  column: number,
): number | null {
  if (ranges.length === 0) return null;

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const distance =
      column < range.start ? range.start - column : column > range.end ? column - range.end : 0;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function normalizeSelectionPoints(
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
): { start: TerminalSelectionPoint; end: TerminalSelectionPoint } {
  if (anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

function extractText(
  terminal: Terminal,
  start: TerminalSelectionPoint,
  end: TerminalSelectionPoint,
): string {
  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = terminal.buffer.active.getLine(row);
    if (!line) {
      lines.push("");
      continue;
    }
    const from = row === start.row ? start.column : 0;
    const to = row === end.row ? end.column + 1 : terminal.cols;
    lines.push(line.translateToString(true, from, to));
  }
  return lines.join("\n").replace(/\s+$/, "");
}

export function getTerminalPointAtClient({
  terminal,
  host,
  clientX,
  clientY,
  cellWidth,
  cellHeight,
}: TerminalPointAtClientOptions): TerminalSelectionPoint | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const measured = getCellSize({ terminal, host, cellWidth, cellHeight });
  if (!measured?.cellW || !measured.cellH) return null;

  const rect = screen.getBoundingClientRect();
  const rowInViewport = Math.floor((clientY - rect.top) / measured.cellH);
  const column = Math.floor((clientX - rect.left) / measured.cellW);
  if (rowInViewport < 0 || rowInViewport >= terminal.rows) return null;
  if (column < 0 || column >= terminal.cols) return null;

  return {
    row: terminal.buffer.active.viewportY + rowInViewport,
    column,
  };
}

export function getClientPositionForTerminalPoint({
  terminal,
  host,
  point,
  affinity = "before",
  cellWidth,
  cellHeight,
}: TerminalPointClientPositionOptions): { left: number; top: number } | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const measured = getCellSize({ terminal, host, cellWidth, cellHeight });
  if (!measured?.cellW || !measured.cellH) return null;

  const rowInViewport = point.row - terminal.buffer.active.viewportY;
  if (rowInViewport < 0 || rowInViewport >= terminal.rows) return null;
  if (point.column < 0 || point.column >= terminal.cols) return null;

  const rect = screen.getBoundingClientRect();
  const columnOffset = affinity === "after" ? point.column + 1 : point.column;
  return {
    left: rect.left + columnOffset * measured.cellW,
    top: rect.top + (rowInViewport + 1) * measured.cellH,
  };
}

export function selectTerminalRange({
  terminal,
  anchor,
  focus,
}: SelectTerminalRangeOptions): TerminalSelectionResult | null {
  const { start, end } = normalizeSelectionPoints(anchor, focus);
  const rowSpan = Math.max(0, end.row - start.row);
  const length = rowSpan * terminal.cols + (end.column - start.column) + 1;
  if (length <= 0) return null;

  terminal.select(start.column, start.row, length);
  const text = terminal.getSelection?.() || extractText(terminal, start, end);
  if (!text.trim()) return null;
  return { anchor, focus, text };
}

export function selectTerminalLineAtPoint({
  terminal,
  host,
  clientX,
  clientY,
  cellWidth,
  cellHeight,
}: SelectTerminalLineAtPointOptions): TerminalSelectionResult | null {
  const point = getTerminalPointAtClient({
    terminal,
    host,
    clientX,
    clientY,
    cellWidth,
    cellHeight,
  });
  if (!point) return null;

  const line = terminal.buffer.active.getLine(point.row);
  if (!line) return null;

  const range = findNonBlankCellRange(line, terminal.cols);
  if (!range) return null;

  return selectTerminalRange({
    terminal,
    anchor: { row: point.row, column: range.start },
    focus: { row: point.row, column: range.end },
  });
}

export function selectTerminalTokenAtPoint({
  terminal,
  host,
  clientX,
  clientY,
  cellWidth,
  cellHeight,
}: SelectTerminalTokenAtPointOptions): TerminalSelectionResult | null {
  const point = getTerminalPointAtClient({
    terminal,
    host,
    clientX,
    clientY,
    cellWidth,
    cellHeight,
  });
  if (!point) return null;

  const line = terminal.buffer.active.getLine(point.row);
  if (!line) return null;

  const range = findTokenCellRange(line, point.column, terminal.cols);
  if (!range) return null;

  return selectTerminalRange({
    terminal,
    anchor: { row: point.row, column: range.start },
    focus: { row: point.row, column: range.end },
  });
}

export function selectTerminalInitialRangeAtPoint({
  terminal,
  host,
  clientX,
  clientY,
  cellWidth,
  cellHeight,
}: SelectTerminalInitialRangeAtPointOptions): TerminalSelectionResult | null {
  const point = getTerminalPointAtClient({
    terminal,
    host,
    clientX,
    clientY,
    cellWidth,
    cellHeight,
  });
  if (!point) return null;

  return selectTerminalInitialRangeAtBufferPoint({ terminal, point });
}

export function selectTerminalInitialRangeAtBufferPoint({
  terminal,
  point,
}: SelectTerminalInitialRangeAtBufferPointOptions): TerminalSelectionResult | null {
  const line = terminal.buffer.active.getLine(point.row);
  if (!line) return null;

  const ranges = findSemanticTokenCellRanges(line, terminal.cols);
  const tokenIndex = findNearestTokenIndex(ranges, point.column);
  if (tokenIndex === null) return null;

  const range = ranges[tokenIndex];
  if (!range) return null;
  return selectTerminalRange({
    terminal,
    anchor: { row: point.row, column: range.start },
    focus: { row: point.row, column: range.end },
  });
}

export function selectTerminalPathLinkAtBufferPoint({
  terminal,
  point,
}: SelectTerminalPathLinkAtBufferPointOptions): TerminalPathSelectionResult | null {
  const lineNumber = point.row + 1;
  const column = point.column + 1;
  const candidate = [
    ...findImagePreviewPathMatchesInWrappedBuffer(terminal, lineNumber).map((match) => ({
      match,
      pathAction: { kind: "image-preview", path: match.path } as const,
    })),
    ...findFileDownloadPathMatchesInWrappedBuffer(terminal, lineNumber).map((match) => ({
      match,
      pathAction: { kind: "file-download", path: match.path } as const,
    })),
  ].find(({ match }) => {
    if (lineNumber < match.startLineNumber || lineNumber > match.endLineNumber) {
      return false;
    }
    if (lineNumber === match.startLineNumber && column < match.startColumn) {
      return false;
    }
    if (lineNumber === match.endLineNumber && column > match.endColumn) {
      return false;
    }
    return true;
  });
  if (!candidate) return null;

  const selected = selectTerminalRange({
    terminal,
    anchor: {
      row: candidate.match.startLineNumber - 1,
      column: candidate.match.startColumn - 1,
    },
    focus: {
      row: candidate.match.endLineNumber - 1,
      column: candidate.match.endColumn - 1,
    },
  });
  return selected ? { ...selected, pathAction: candidate.pathAction } : null;
}
