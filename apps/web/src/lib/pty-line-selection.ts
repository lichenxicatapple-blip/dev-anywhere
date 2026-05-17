import type { Terminal } from "@xterm/xterm";
import { measureXtermCellSize } from "./pty-xterm-metrics";
import { findFileDownloadPathMatches } from "./xterm-file-download-links";

export interface TerminalSelectionPoint {
  row: number;
  column: number;
}

export interface TerminalSelectionResult {
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
  text: string;
}

export interface TerminalFileDownloadSelectionResult extends TerminalSelectionResult {
  downloadPath: string;
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

type SelectTerminalFileDownloadLinkAtBufferPointOptions =
  SelectTerminalInitialRangeAtBufferPointOptions;

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

function findTokenCellRanges(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  maxCols: number,
): Array<{ start: number; end: number }> {
  const endLimit = Math.min(line.length, maxCols);
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < endLimit) {
    while (index < endLimit && !hasVisibleChars(line, index)) index += 1;
    if (index >= endLimit) break;

    const start = index;
    while (index + 1 < endLimit && hasVisibleChars(line, index + 1)) index += 1;
    ranges.push({ start, end: index });
    index += 1;
  }
  return ranges;
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

function expandInitialTokenRange(
  ranges: Array<{ start: number; end: number }>,
  tokenIndex: number,
  column: number,
): { start: number; end: number } {
  const minSelectionCells = 18;
  const maxSelectionTokens = 3;
  const token = ranges[tokenIndex];
  if (!token) return { start: 0, end: 0 };
  if (token.end - token.start + 1 >= minSelectionCells) return token;

  let startIndex = tokenIndex;
  let endIndex = tokenIndex;
  const selectedCellCount = (): number => ranges[endIndex].end - ranges[startIndex].start + 1;
  const selectedTokenCount = (): number => endIndex - startIndex + 1;

  while (selectedCellCount() < minSelectionCells && selectedTokenCount() < maxSelectionTokens) {
    const left = startIndex > 0 ? ranges[startIndex - 1] : null;
    const right = endIndex + 1 < ranges.length ? ranges[endIndex + 1] : null;
    if (!left && !right) break;

    if (left && right) {
      const leftDistance = Math.max(0, column - left.end);
      const rightDistance = Math.max(0, right.start - column);
      if (leftDistance <= rightDistance) {
        startIndex -= 1;
      } else {
        endIndex += 1;
      }
    } else if (left) {
      startIndex -= 1;
    } else {
      endIndex += 1;
    }
  }

  return { start: ranges[startIndex].start, end: ranges[endIndex].end };
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

  const ranges = findTokenCellRanges(line, terminal.cols);
  const tokenIndex = findNearestTokenIndex(ranges, point.column);
  if (tokenIndex === null) return null;

  const range = expandInitialTokenRange(ranges, tokenIndex, point.column);
  return selectTerminalRange({
    terminal,
    anchor: { row: point.row, column: range.start },
    focus: { row: point.row, column: range.end },
  });
}

export function selectTerminalFileDownloadLinkAtBufferPoint({
  terminal,
  point,
}: SelectTerminalFileDownloadLinkAtBufferPointOptions): TerminalFileDownloadSelectionResult | null {
  const line = terminal.buffer.active.getLine(point.row);
  if (!line) return null;

  const text = line.translateToString(true);
  const column = point.column + 1;
  const match = findFileDownloadPathMatches(text).find(
    (candidate) => column >= candidate.startColumn && column <= candidate.endColumn,
  );
  if (!match) return null;

  const selected = selectTerminalRange({
    terminal,
    anchor: { row: point.row, column: match.startColumn - 1 },
    focus: { row: point.row, column: match.endColumn - 1 },
  });
  return selected ? { ...selected, downloadPath: match.path } : null;
}
