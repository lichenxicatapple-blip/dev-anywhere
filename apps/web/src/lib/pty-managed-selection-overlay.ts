import type { IBufferLine, IBufferRange, Terminal } from "@xterm/xterm";
import { getRenderedPtyHistoryProjectionRange } from "./pty-history-projection";
import type { PtySelectionBufferPoint, PtySelectionRange } from "./pty-managed-selection-state";

export interface PtyManagedSelectionOverlayOptions {
  terminal: Terminal;
  container: HTMLElement;
  selectionBackground?: string;
  getLine?: (row: number) => IBufferLine | null | undefined;
  /** Resolve a moving xterm-owned range whenever the overlay repaints. */
  resolveRange?: () => PtySelectionRange | null;
  /** Paint only the rows serialized into the current live-backfill shell. */
  projectionOnly?: boolean;
  overlaySlot?: string;
  segmentSlot?: string;
  opacity?: string;
  borderColor?: string;
}

export interface PtyManagedSelectionOverlayController {
  render: (range: PtySelectionRange | null) => void;
  dispose: () => void;
}

interface SelectionSegment {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly columnCount: number;
}

const OVERLAY_SLOT = "pty-managed-selection-overlay";
const SEGMENT_SLOT = "pty-managed-selection-segment";
const DEFAULT_SELECTION_BACKGROUND = "#264f78";
const SELECTION_OPACITY = "0.62";

/** Converts xterm's end-exclusive selection range into our inclusive endpoint model. */
export function xtermSelectionToPtySelectionRange(
  selection: IBufferRange | undefined,
  cols: number,
): PtySelectionRange | null {
  if (!selection || cols <= 0) return null;
  const coordinates = [selection.start.x, selection.start.y, selection.end.x, selection.end.y];
  if (
    coordinates.some((value) => !Number.isInteger(value) || value < 0) ||
    selection.start.x > cols ||
    selection.end.x > cols
  ) {
    return null;
  }
  const startOffset = selection.start.y * cols + selection.start.x;
  const endOffset = selection.end.y * cols + selection.end.x;
  if (endOffset <= startOffset) return null;
  const lastOffset = endOffset - 1;
  const start = { row: Math.floor(startOffset / cols), column: startOffset % cols };
  const focus = { row: Math.floor(lastOffset / cols), column: lastOffset % cols };
  return { anchor: start, focus, columnMode: false };
}

function isValidPoint(point: PtySelectionBufferPoint): boolean {
  return (
    Number.isInteger(point.row) &&
    point.row >= 0 &&
    Number.isInteger(point.column) &&
    point.column >= 0
  );
}

function cloneRange(range: PtySelectionRange): PtySelectionRange {
  return {
    anchor: { row: range.anchor.row, column: range.anchor.column },
    focus: { row: range.focus.row, column: range.focus.column },
    columnMode: range.columnMode,
  };
}

function comparePoints(a: PtySelectionBufferPoint, b: PtySelectionBufferPoint): number {
  return a.row === b.row ? a.column - b.column : a.row - b.row;
}

function getGlyphSpan(
  line: IBufferLine | null | undefined,
  column: number,
  cols: number,
): { start: number; end: number } {
  let start = Math.max(0, Math.min(cols - 1, column));
  while (start > 0 && line?.getCell(start)?.getWidth() === 0) start -= 1;
  const width = Math.max(1, line?.getCell(start)?.getWidth() ?? 1);
  return { start, end: Math.min(cols, start + width) };
}

function appendMergedSegment(segments: SelectionSegment[], next: SelectionSegment): void {
  const previous = segments.at(-1);
  if (
    previous &&
    previous.lastRow + 1 === next.firstRow &&
    previous.firstColumn === next.firstColumn &&
    previous.columnCount === next.columnCount
  ) {
    segments[segments.length - 1] = { ...previous, lastRow: next.lastRow };
    return;
  }
  segments.push(next);
}

function getSelectionSegments(
  range: PtySelectionRange,
  cols: number,
  getLine?: PtyManagedSelectionOverlayOptions["getLine"],
  visibleRows?: { first: number; last: number },
): SelectionSegment[] {
  if (cols <= 0 || !isValidPoint(range.anchor) || !isValidPoint(range.focus)) return [];

  const [start, end] =
    comparePoints(range.anchor, range.focus) <= 0
      ? [range.anchor, range.focus]
      : [range.focus, range.anchor];
  const startSpan = getGlyphSpan(getLine?.(start.row), start.column, cols);
  const endSpan = getGlyphSpan(getLine?.(end.row), end.column, cols);

  if (range.columnMode) {
    const firstRow = Math.max(Math.min(range.anchor.row, range.focus.row), visibleRows?.first ?? 0);
    const lastRow = Math.min(
      Math.max(range.anchor.row, range.focus.row),
      visibleRows?.last ?? Number.MAX_SAFE_INTEGER,
    );
    if (lastRow < firstRow) return [];
    const leftColumn = Math.min(range.anchor.column, range.focus.column);
    const rightColumn = Math.max(range.anchor.column, range.focus.column);
    const segments: SelectionSegment[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const line = getLine?.(row);
      const left = getGlyphSpan(line, leftColumn, cols).start;
      const right = getGlyphSpan(line, rightColumn, cols).end;
      appendMergedSegment(segments, {
        firstRow: row,
        lastRow: row,
        firstColumn: left,
        columnCount: Math.max(0, right - left),
      });
    }
    return segments;
  }

  if (start.row === end.row) {
    return [
      {
        firstRow: start.row,
        lastRow: end.row,
        firstColumn: startSpan.start,
        columnCount: endSpan.end - startSpan.start,
      },
    ];
  }

  const segments: SelectionSegment[] = [
    {
      firstRow: start.row,
      lastRow: start.row,
      firstColumn: startSpan.start,
      columnCount: cols - startSpan.start,
    },
  ];
  if (end.row - start.row > 1) {
    segments.push({
      firstRow: start.row + 1,
      lastRow: end.row - 1,
      firstColumn: 0,
      columnCount: cols,
    });
  }
  segments.push({
    firstRow: end.row,
    lastRow: end.row,
    firstColumn: 0,
    columnCount: endSpan.end,
  });
  return segments;
}

function clipSegmentsToRows(
  segments: readonly SelectionSegment[],
  firstRow: number,
  lastRow: number,
): SelectionSegment[] {
  if (lastRow < firstRow) return [];
  const clipped: SelectionSegment[] = [];
  for (const segment of segments) {
    const first = Math.max(segment.firstRow, firstRow);
    const last = Math.min(segment.lastRow, lastRow);
    if (last < first) continue;
    appendMergedSegment(clipped, { ...segment, firstRow: first, lastRow: last });
  }
  return clipped;
}

function createOverlay(screen: HTMLElement, slot: string): HTMLElement {
  const overlay = screen.ownerDocument.createElement("div");
  overlay.dataset.slot = slot;
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "3",
  });
  screen.append(overlay);
  return overlay;
}

/**
 * Paints an absolute-buffer selection independently of xterm's native selection service.
 *
 * Rows deliberately are not clamped to xterm's screen: live-backfill rows can sit above the
 * current viewport, while a selection may continue below it. Each rectangle is clipped only
 * to the outer scroll container's visible vertical span; horizontal overflow remains owned by
 * that container.
 */
export function attachPtyManagedSelectionOverlay({
  terminal,
  container,
  selectionBackground,
  getLine,
  resolveRange,
  projectionOnly = false,
  overlaySlot = OVERLAY_SLOT,
  segmentSlot = SEGMENT_SLOT,
  opacity = SELECTION_OPACITY,
  borderColor,
}: PtyManagedSelectionOverlayOptions): PtyManagedSelectionOverlayController {
  let currentRange: PtySelectionRange | null = null;
  let screen: HTMLElement | null = null;
  let overlay: HTMLElement | null = null;
  let disposed = false;

  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => paint());
  resizeObserver?.observe(container);

  const resolveScreen = (): HTMLElement | null => {
    const next = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    if (next === screen) return screen;

    if (screen) resizeObserver?.unobserve(screen);
    overlay?.remove();
    overlay = null;
    screen = next;
    if (screen) resizeObserver?.observe(screen);
    return screen;
  };

  const clearOverlay = (): void => {
    overlay?.remove();
    overlay = null;
  };

  function paint(): void {
    const range = currentRange && resolveRange ? resolveRange() : currentRange;
    if (disposed || !range) {
      clearOverlay();
      return;
    }

    const resolvedScreen = resolveScreen();
    if (!resolvedScreen || terminal.cols <= 0 || terminal.rows <= 0) {
      clearOverlay();
      return;
    }
    const screenRect = resolvedScreen.getBoundingClientRect();
    const metrics = {
      cellW: screenRect.width / terminal.cols,
      cellH: screenRect.height / terminal.rows,
    };
    if (metrics.cellW <= 0 || metrics.cellH <= 0) {
      clearOverlay();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const visibleHeight =
      container.clientHeight > 0 ? container.clientHeight : containerRect.height;
    const visibleTop =
      containerRect.top + (container.clientHeight > 0 ? container.clientTop : 0) - screenRect.top;
    const visibleBottom = visibleTop + visibleHeight;
    if (!Number.isFinite(visibleTop) || !Number.isFinite(visibleBottom) || visibleHeight <= 0) {
      return;
    }

    const projection = terminal.element
      ? getRenderedPtyHistoryProjectionRange(terminal.element)
      : null;
    if (projectionOnly && !projection) {
      clearOverlay();
      return;
    }
    const rowOrigin = projection?.startLine ?? terminal.buffer.active.viewportY;
    const topOrigin = projection
      ? projection.element.getBoundingClientRect().top - screenRect.top
      : 0;
    if (!Number.isFinite(topOrigin)) {
      clearOverlay();
      return;
    }
    const visibleRows = {
      first: rowOrigin + Math.floor((visibleTop - topOrigin) / metrics.cellH),
      last: rowOrigin + Math.ceil((visibleBottom - topOrigin) / metrics.cellH) - 1,
    };
    if (projectionOnly && projection) {
      visibleRows.first = Math.max(visibleRows.first, projection.startLine);
      visibleRows.last = Math.min(visibleRows.last, projection.endLine);
    }
    const getSegmentsForRows = (first: number, last: number): SelectionSegment[] =>
      clipSegmentsToRows(
        getSelectionSegments(range, terminal.cols, getLine, { first, last }),
        first,
        last,
      );
    // The live projection is an atomic bridge for the current painted frame. Its first row and
    // DOM top therefore define one continuous row plane, including rows extrapolated beyond the
    // serialized band; active.viewportY may already describe a not-yet-painted xterm frame.
    const segments = getSegmentsForRows(visibleRows.first, visibleRows.last);
    if (segments.length === 0) {
      clearOverlay();
      return;
    }

    if (!overlay || overlay.ownerDocument !== resolvedScreen.ownerDocument) {
      clearOverlay();
      overlay = createOverlay(resolvedScreen, overlaySlot);
    } else if (overlay.parentElement !== resolvedScreen) {
      resolvedScreen.append(overlay);
    }
    overlay.replaceChildren();
    overlay.dataset.anchorRow = String(range.anchor.row);
    overlay.dataset.anchorColumn = String(range.anchor.column);
    overlay.dataset.focusRow = String(range.focus.row);
    overlay.dataset.focusColumn = String(range.focus.column);

    const background =
      selectionBackground ??
      terminal.options.theme?.selectionBackground ??
      DEFAULT_SELECTION_BACKGROUND;

    for (const segment of segments) {
      const naturalTop = topOrigin + (segment.firstRow - rowOrigin) * metrics.cellH;
      const naturalBottom = topOrigin + (segment.lastRow - rowOrigin + 1) * metrics.cellH;
      const clippedTop = Math.max(naturalTop, visibleTop);
      const clippedBottom = Math.min(naturalBottom, visibleBottom);
      if (clippedBottom <= clippedTop || segment.columnCount <= 0) continue;

      const rectangle = resolvedScreen.ownerDocument.createElement("div");
      rectangle.dataset.slot = segmentSlot;
      rectangle.dataset.firstRow = String(segment.firstRow);
      rectangle.dataset.lastRow = String(segment.lastRow);
      rectangle.dataset.firstColumn = String(segment.firstColumn);
      rectangle.dataset.columnCount = String(segment.columnCount);
      Object.assign(rectangle.style, {
        position: "absolute",
        left: `${segment.firstColumn * metrics.cellW}px`,
        top: `${clippedTop}px`,
        width: `${segment.columnCount * metrics.cellW}px`,
        height: `${clippedBottom - clippedTop}px`,
        backgroundColor: background,
        opacity,
        boxShadow: borderColor ? `inset 0 0 0 1px ${borderColor}` : "",
        pointerEvents: "none",
      });
      overlay.append(rectangle);
    }
  }

  const repaint = (): void => paint();
  container.addEventListener("scroll", repaint, { passive: true });
  const scrollDisposable = terminal.onScroll(repaint);
  const renderDisposable = terminal.onRender(repaint);
  const resizeDisposable = terminal.onResize(repaint);

  return {
    render: (range) => {
      if (disposed) return;
      currentRange = range ? cloneRange(range) : null;
      paint();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      container.removeEventListener("scroll", repaint);
      scrollDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      resizeObserver?.disconnect();
      currentRange = null;
      screen = null;
      clearOverlay();
    },
  };
}
