import type { IBufferLine, Terminal } from "@xterm/xterm";
import {
  getRenderedPtyHistoryProjectionRange,
  getRenderedPtyHistorySelectionLine,
} from "./pty-history-projection";
import { measureXtermCellSize } from "./pty-xterm-metrics";
import type { PtySelectionPathAction } from "./pty-selection-path-action";
import { findFileDownloadPathMatchesInWrappedBuffer } from "./xterm-file-download-links";
import { findImagePreviewPathMatchesInWrappedBuffer } from "./xterm-image-preview-links";

export interface TerminalSelectionPoint {
  row: number;
  column: number;
}

export interface TerminalSelectionResult {
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
  text: string;
  columnMode?: boolean;
}

export interface TerminalPathSelectionResult extends TerminalSelectionResult {
  pathAction: PtySelectionPathAction;
}

interface TerminalPointAtClientOptions {
  terminal: Terminal;
  host: HTMLElement;
  clientX: number;
  clientY: number;
  cellWidth?: number;
  cellHeight?: number;
  /**
   * Active drags may leave the painted terminal bounds while the outer viewport autoscrolls.
   * Clamp those coordinates to the nearest real buffer cell. Press/click hit testing deliberately
   * leaves this off so terminal padding can never manufacture a selection anchor.
   */
  clampToBuffer?: boolean;
}

interface SelectTerminalInitialRangeAtBufferPointOptions {
  terminal: Terminal;
  point: TerminalSelectionPoint;
}

type SelectTerminalPathLinkAtBufferPointOptions = SelectTerminalInitialRangeAtBufferPointOptions;

interface SelectTerminalRangeOptions {
  terminal: Terminal;
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
  columnMode?: boolean;
}

interface TerminalPointClientPositionOptions {
  terminal: Terminal;
  host: HTMLElement;
  point: TerminalSelectionPoint;
  affinity?: "before" | "after";
  cellWidth?: number;
  cellHeight?: number;
  getLine?: (row: number) => IBufferLine | null | undefined;
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
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const rect = screen?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0 && terminal.cols > 0 && terminal.rows > 0) {
    return { cellW: rect.width / terminal.cols, cellH: rect.height / terminal.rows };
  }
  return measureXtermCellSize(host, terminal);
}

function getGlyphStartColumn(line: IBufferLine | null | undefined, column: number): number {
  let start = column;
  while (start > 0 && line?.getCell(start)?.getWidth() === 0) start -= 1;
  return start;
}

function getGlyphEndColumnExclusive(
  line: IBufferLine | null | undefined,
  column: number,
  cols: number,
): number {
  const start = getGlyphStartColumn(line, column);
  const width = Math.max(1, line?.getCell(start)?.getWidth() ?? 1);
  return Math.min(cols, start + width);
}

function normalizePointToGlyphStart(
  terminal: Terminal,
  host: HTMLElement,
  point: TerminalSelectionPoint,
): TerminalSelectionPoint {
  const line =
    getRenderedPtyHistorySelectionLine(host, point.row) ??
    terminal.buffer.active.getLine(point.row);
  return { ...point, column: getGlyphStartColumn(line, point.column) };
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

  // `trimEnd()` would incorrectly discard explicitly printed spaces. xterm's trimRight only
  // removes cells without content, so use its own translated prefix as the authoritative length.
  const trimmedText = line.translateToString(true, 0, endLimit);
  return {
    text: text.slice(0, trimmedText.length),
    spans: spans.filter((span) => span.textStart < trimmedText.length),
  };
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

export function normalizeTerminalSelectionPoints(
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
): { start: TerminalSelectionPoint; end: TerminalSelectionPoint } {
  if (anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

export function extractTerminalRangeText(
  terminal: Terminal,
  start: TerminalSelectionPoint,
  end: TerminalSelectionPoint,
  columnMode = false,
): string {
  if (columnMode) {
    const firstRow = Math.min(start.row, end.row);
    const lastRow = Math.max(start.row, end.row);
    const firstColumn = Math.min(start.column, end.column);
    const lastColumn = Math.max(start.column, end.column);
    const lines: string[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const line = terminal.buffer.active.getLine(row);
      if (!line) continue;
      const from = getGlyphStartColumn(line, firstColumn);
      const to = getGlyphEndColumnExclusive(line, lastColumn, terminal.cols);
      lines.push(line.translateToString(true, from, to).replace(/\u00a0/g, " "));
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = terminal.buffer.active.getLine(row);
    if (!line) continue;
    const from = row === start.row ? getGlyphStartColumn(line, start.column) : 0;
    const to =
      row === end.row ? getGlyphEndColumnExclusive(line, end.column, terminal.cols) : terminal.cols;
    const text = line.translateToString(true, from, to).replace(/\u00a0/g, " ");
    if (row > start.row && line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

export function resolveTerminalRange({
  terminal,
  anchor,
  focus,
  columnMode = false,
}: SelectTerminalRangeOptions): TerminalSelectionResult | null {
  if (
    anchor.row < 0 ||
    focus.row < 0 ||
    anchor.row >= terminal.buffer.active.length ||
    focus.row >= terminal.buffer.active.length ||
    anchor.column < 0 ||
    focus.column < 0 ||
    anchor.column >= terminal.cols ||
    focus.column >= terminal.cols
  ) {
    return null;
  }
  const normalizedAnchor = {
    ...anchor,
    column: getGlyphStartColumn(terminal.buffer.active.getLine(anchor.row), anchor.column),
  };
  const normalizedFocus = {
    ...focus,
    column: getGlyphStartColumn(terminal.buffer.active.getLine(focus.row), focus.column),
  };
  const { start, end } = normalizeTerminalSelectionPoints(normalizedAnchor, normalizedFocus);
  const text = extractTerminalRangeText(
    terminal,
    columnMode ? normalizedAnchor : start,
    columnMode ? normalizedFocus : end,
    columnMode,
  );
  return { anchor: normalizedAnchor, focus: normalizedFocus, text, columnMode };
}

export function getTerminalPointAtClient({
  terminal,
  host,
  clientX,
  clientY,
  cellWidth,
  cellHeight,
  clampToBuffer = false,
}: TerminalPointAtClientOptions): TerminalSelectionPoint | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const measured = getCellSize({ terminal, host, cellWidth, cellHeight });
  if (!measured?.cellW || !measured.cellH) return null;

  const rect = screen.getBoundingClientRect();
  const projection = getRenderedPtyHistoryProjectionRange(host);
  const projectionRect = projection?.element.getBoundingClientRect();
  const rowOrigin = projection?.startLine ?? terminal.buffer.active.viewportY;
  const topOrigin = projectionRect?.top ?? rect.top;
  const rawRow = rowOrigin + Math.floor((clientY - topOrigin) / measured.cellH);
  const rawColumn = Math.floor((clientX - rect.left) / measured.cellW);
  if (clampToBuffer) {
    if (terminal.buffer.active.length <= 0 || terminal.cols <= 0) return null;
    return normalizePointToGlyphStart(terminal, host, {
      row: Math.max(0, Math.min(terminal.buffer.active.length - 1, rawRow)),
      column: Math.max(0, Math.min(terminal.cols - 1, rawColumn)),
    });
  }
  if (rawColumn < 0 || rawColumn >= terminal.cols) return null;

  // While a live projection is present it is the painted row plane, including the native rows
  // immediately outside its serialized interval. xterm's active viewport may already point at a
  // requested future paint, so mixing it back in here would move selections before the pixels do.
  if (projection && projectionRect) {
    const projectionBottom =
      projectionRect.top + (projection.endLine - projection.startLine + 1) * measured.cellH;
    const screenBottom = rect.top + terminal.rows * measured.cellH;
    const insideProjection = clientY >= projectionRect.top && clientY < projectionBottom;
    const insideNativeScreen = clientY >= rect.top && clientY < screenBottom;
    if (!insideProjection && !insideNativeScreen) return null;
  } else {
    const rowInNativeViewport = Math.floor((clientY - rect.top) / measured.cellH);
    if (rowInNativeViewport < 0 || rowInNativeViewport >= terminal.rows) return null;
  }
  if (rawRow < 0 || rawRow >= terminal.buffer.active.length) return null;

  return normalizePointToGlyphStart(terminal, host, {
    row: rawRow,
    column: rawColumn,
  });
}

export function getClientPositionForTerminalPoint({
  terminal,
  host,
  point,
  affinity = "before",
  cellWidth,
  cellHeight,
  getLine,
}: TerminalPointClientPositionOptions): { left: number; top: number } | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const measured = getCellSize({ terminal, host, cellWidth, cellHeight });
  if (!measured?.cellW || !measured.cellH) return null;

  const rowInViewport = point.row - terminal.buffer.active.viewportY;
  if (point.row < 0 || point.row >= terminal.buffer.active.length) return null;
  if (point.column < 0 || point.column >= terminal.cols) return null;

  const rect = screen.getBoundingClientRect();
  const line = getLine?.(point.row) ?? terminal.buffer.active.getLine(point.row);
  const glyphStart = getGlyphStartColumn(line, point.column);
  const width = Math.max(1, line?.getCell(glyphStart)?.getWidth() ?? 1);
  const columnOffset = affinity === "after" ? glyphStart + width : glyphStart;

  // A live projection is the authoritative row plane for the whole painted frame, not only for
  // rows inside its serialized interval. This keeps handles attached to the visible pixels while
  // xterm's active viewport is ahead of the host paint during compositor-native scrolling.
  const projection = getRenderedPtyHistoryProjectionRange(host);
  if (projection) {
    const projectionRect = projection.element.getBoundingClientRect();
    return {
      left: rect.left + columnOffset * measured.cellW,
      top: projectionRect.top + (point.row - projection.startLine + 1) * measured.cellH,
    };
  }

  return {
    left: rect.left + columnOffset * measured.cellW,
    top: rect.top + (rowInViewport + 1) * measured.cellH,
  };
}

export function resolveTerminalInitialRangeAtBufferPoint({
  terminal,
  point,
}: SelectTerminalInitialRangeAtBufferPointOptions): TerminalSelectionResult | null {
  const buffer = terminal.buffer.active;
  if (!buffer.getLine(point.row)) return null;

  let firstRow = point.row;
  let lastRow = point.row;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow -= 1;
  while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow += 1;

  const mappedSpans: Array<TerminalLineTextCellSpan & { row: number }> = [];
  let logicalText = "";
  for (let row = firstRow; row <= lastRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const { text, spans } = getTerminalLineTextAndCellSpans(line, terminal.cols);
    const textOffset = logicalText.length;
    logicalText += text;
    mappedSpans.push(
      ...spans.map((span) => ({
        ...span,
        row,
        textStart: span.textStart + textOffset,
        textEnd: span.textEnd + textOffset,
      })),
    );
  }

  const targetSpan = mappedSpans.find(
    (span) =>
      span.row === point.row && point.column >= span.cellStart && point.column <= span.cellEnd,
  );
  if (!targetSpan) return null;
  let semanticRange = findSemanticTextRanges(logicalText).find(
    (range) => range.start < targetSpan.textEnd && range.end > targetSpan.textStart,
  );
  if (!semanticRange) {
    const targetIndex = mappedSpans.indexOf(targetSpan);
    const targetText = logicalText.slice(targetSpan.textStart, targetSpan.textEnd);
    if (targetIndex < 0 || targetText.trim().length > 0) return null;
    let firstWhitespace = targetIndex;
    let lastWhitespace = targetIndex;
    while (
      firstWhitespace > 0 &&
      logicalText
        .slice(mappedSpans[firstWhitespace - 1].textStart, mappedSpans[firstWhitespace - 1].textEnd)
        .trim().length === 0
    ) {
      firstWhitespace -= 1;
    }
    while (
      lastWhitespace + 1 < mappedSpans.length &&
      logicalText
        .slice(mappedSpans[lastWhitespace + 1].textStart, mappedSpans[lastWhitespace + 1].textEnd)
        .trim().length === 0
    ) {
      lastWhitespace += 1;
    }
    semanticRange = {
      start: mappedSpans[firstWhitespace].textStart,
      end: mappedSpans[lastWhitespace].textEnd,
    };
  }
  const covered = mappedSpans.filter(
    (span) => span.textStart < semanticRange.end && span.textEnd > semanticRange.start,
  );
  const first = covered[0];
  const last = covered.at(-1);
  if (!first || !last) return null;
  return resolveTerminalRange({
    terminal,
    anchor: { row: first.row, column: first.cellStart },
    focus: { row: last.row, column: last.cellEnd },
  });
}

export function resolveTerminalLineAtBufferPoint({
  terminal,
  point,
}: SelectTerminalInitialRangeAtBufferPointOptions): TerminalSelectionResult | null {
  const buffer = terminal.buffer.active;
  if (!buffer.getLine(point.row)) return null;
  let firstRow = point.row;
  let lastRow = point.row;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow -= 1;
  while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow += 1;

  return resolveTerminalRange({
    terminal,
    anchor: { row: firstRow, column: 0 },
    focus: { row: lastRow, column: Math.max(0, terminal.cols - 1) },
  });
}

export function resolveTerminalPathLinkAtBufferPoint({
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
    if (lineNumber < match.startLineNumber || lineNumber > match.endLineNumber) return false;
    if (lineNumber === match.startLineNumber && column < match.startColumn) return false;
    if (lineNumber === match.endLineNumber && column > match.endColumn) return false;
    return true;
  });
  if (!candidate) return null;

  const selected = resolveTerminalRange({
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
