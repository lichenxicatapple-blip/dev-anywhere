import type { IBufferLine } from "@xterm/xterm";
import { snapshotPtySelectionBufferLine } from "./pty-selection-buffer-snapshot";

export type PtyHistoryProjectionKind = "review" | "live-backfill";

export interface PtyHistoryProjection {
  kind: PtyHistoryProjectionKind;
  startLine: number;
  endLine: number;
  rowHeight: number;
  topOffset: number;
}

interface PtyHistoryProjectionController {
  render: (projection: PtyHistoryProjection | null) => boolean;
  dispose: () => void;
}

interface PtyHistoryProjectionOptions {
  serializeRangeAsHtml?: (startLine: number, endLine: number) => string;
  getSerializedCell?: (line: number, column: number) => PtyHistorySerializedCell | null;
  getSelectionLine?: (line: number) => IBufferLine | null;
  getBufferRowIdentityOffset?: () => number;
}

interface PtyHistorySerializedCell {
  text: string;
  isDim: boolean;
  isRenderedFgRGB: boolean;
}

const REVIEW_SLOT = "pty-review-snapshot";
const LIVE_BACKFILL_SLOT = "pty-live-backfill";
interface PtyHistoryProjectionSelectionSource {
  readonly capturedRowIdentityOffset: number;
  readonly getCurrentRowIdentityOffset?: () => number;
  readonly lines: ReadonlyMap<number, IBufferLine>;
  rebasedDelta?: number;
  rebasedLines?: ReadonlyMap<number, IBufferLine>;
}

const projectionSelectionLines = new WeakMap<HTMLElement, PtyHistoryProjectionSelectionSource>();
const EMPTY_PROJECTION_SELECTION_LINES: ReadonlyMap<number, IBufferLine> = new Map();

function getRenderedProjection(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    '.xterm-screen [data-slot="pty-review-snapshot"], .xterm-screen [data-slot="pty-live-backfill"]',
  );
}

function getProjectionRowDelta(source: PtyHistoryProjectionSelectionSource): number {
  const current = source.getCurrentRowIdentityOffset?.() ?? source.capturedRowIdentityOffset;
  const delta = current - source.capturedRowIdentityOffset;
  return Number.isInteger(delta) ? delta : 0;
}

export function getRenderedPtyHistoryProjectionRange(
  host: HTMLElement,
): { element: HTMLElement; startLine: number; endLine: number } | null {
  const projection = getRenderedProjection(host);
  const source = projection ? projectionSelectionLines.get(projection) : undefined;
  if (!projection || !source) return null;
  const delta = getProjectionRowDelta(source);
  const startLine = Number(projection.dataset.startLine) + delta;
  const endLine = Number(projection.dataset.endLine) + delta;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { element: projection, startLine, endLine };
}

/** Returns the immutable lines painted by the current review/backfill shell. */
export function getRenderedPtyHistorySelectionLines(
  host: HTMLElement,
): ReadonlyMap<number, IBufferLine> {
  const projection = getRenderedProjection(host);
  const source = projection ? projectionSelectionLines.get(projection) : undefined;
  if (!source) return EMPTY_PROJECTION_SELECTION_LINES;

  // A public xterm marker supplies the row-identity delta even when viewportY is clamped at the
  // absolute top of scrollback. Rebase immutable rows instead of replacing the frozen frame.
  const delta = getProjectionRowDelta(source);
  if (delta === 0) return source.lines;
  if (source.rebasedDelta === delta && source.rebasedLines) return source.rebasedLines;
  const rebased = new Map<number, IBufferLine>();
  for (const [row, line] of source.lines) {
    const nextRow = row + delta;
    if (nextRow >= 0) rebased.set(nextRow, line);
  }
  source.rebasedDelta = delta;
  source.rebasedLines = rebased;
  return rebased;
}

/** Returns the immutable line painted by the current review/backfill shell, if that row is one. */
export function getRenderedPtyHistorySelectionLine(
  host: HTMLElement,
  row: number,
): IBufferLine | null {
  return getRenderedPtyHistorySelectionLines(host).get(row) ?? null;
}

function findRenderedRows(screen: HTMLElement): HTMLElement | null {
  return (
    Array.from(screen.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("xterm-rows") &&
        child.dataset.slot !== REVIEW_SLOT,
    ) ?? null
  );
}

function createSnapshotShell(
  screen: HTMLElement,
  rows: HTMLElement,
  topOffset: number,
  slot: typeof REVIEW_SLOT | typeof LIVE_BACKFILL_SLOT,
  startLine: number,
  endLine: number,
  capturedRowIdentityOffset: number,
): HTMLElement {
  const next = document.createElement("div");
  next.dataset.slot = slot;
  next.dataset.startLine = String(startLine);
  next.dataset.endLine = String(endLine);
  next.dataset.rowIdentityOffset = String(capturedRowIdentityOffset);
  next.setAttribute("aria-hidden", "true");
  Object.assign(next.style, {
    position: "absolute",
    top: `${topOffset}px`,
    right: "0",
    left: "0",
    height: rows.style.height || "100%",
    overflow: "hidden",
    pointerEvents: "none",
    backgroundColor: getComputedStyle(screen).backgroundColor,
  });
  next.append(rows);
  return next;
}

function isolateSerializedForegroundOpacity(
  rows: HTMLElement,
  startLine: number,
  getSerializedCell?: PtyHistoryProjectionOptions["getSerializedCell"],
): void {
  for (const [rowOffset, row] of Array.from(rows.children).entries()) {
    if (!(row instanceof HTMLElement)) continue;
    let column = 0;

    for (const span of Array.from(row.children)) {
      if (!(span instanceof HTMLElement)) continue;
      const textLength = span.textContent?.length ?? 0;
      let sourceCell = getSerializedCell?.(startLine + rowOffset, column) ?? null;
      while (sourceCell?.text.length === 0) {
        column += 1;
        sourceCell = getSerializedCell?.(startLine + rowOffset, column) ?? null;
      }

      const opacity = span.style.opacity;
      if (opacity && opacity !== "1") {
        // xterm's DOM renderer emits an inline color for a truecolor foreground. CSS cascade makes
        // that declaration win over its `.xterm-dim` class, so SGR dim does not affect the live
        // glyph. SerializeAddon instead emits `color` plus `opacity: 0.5`, which makes the
        // same glyph suddenly fade when history projection takes over. Remove opacity only for
        // that exact cell mode; default and palette foregrounds still use xterm's real dim effect.
        if (sourceCell?.isDim && sourceCell.isRenderedFgRGB) {
          span.style.removeProperty("opacity");
        } else {
          // SerializeAddon applies dim opacity to the whole cell. The live renderer fades only the
          // glyph, so keep the cell background opaque for modes where dim is actually visible.
          span.style.removeProperty("opacity");
          const foreground = document.createElement("span");
          foreground.style.opacity = opacity;
          foreground.append(...Array.from(span.childNodes));
          span.append(foreground);
        }
      }

      let consumedTextLength = 0;
      while (consumedTextLength < textLength) {
        const serializedCell = getSerializedCell?.(startLine + rowOffset, column) ?? null;
        if (!serializedCell) break;
        consumedTextLength += serializedCell.text.length;
        column += 1;
      }
    }
  }
}

function restoreSerializedRowStyleCarry(rows: HTMLElement): void {
  let carriedStyle = "";

  for (const row of Array.from(rows.children)) {
    if (!(row instanceof HTMLElement)) continue;
    const spans = Array.from(row.children).filter(
      (child): child is HTMLSpanElement => child instanceof HTMLSpanElement,
    );
    const first = spans[0];
    if (!first) continue;

    // SerializeAddon keeps style state between rows, but each HTML row starts a
    // fresh unstyled <span>. An empty leading span marks an explicit style
    // transition at column 0; otherwise the first span must inherit the style
    // that ended the previous row.
    const hasLeadingStyleTransition = first.textContent === "" && spans.length > 1;
    if (!hasLeadingStyleTransition && !first.hasAttribute("style") && carriedStyle) {
      first.style.cssText = carriedStyle;
    }

    const last = spans.at(-1);
    if (last) {
      carriedStyle = last.getAttribute("style") ?? "";
    }
  }
}

function createSerializedRows(
  html: string,
  renderedRows: HTMLElement,
  rowHeight: number,
  startLine: number,
  getSerializedCell?: PtyHistoryProjectionOptions["getSerializedCell"],
): HTMLElement | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const serializedRows = parsed.querySelector<HTMLElement>("pre > div");
  if (!serializedRows) return null;

  const rows = document.importNode(serializedRows, true);
  rows.className = renderedRows.className;
  rows.removeAttribute("id");
  restoreSerializedRowStyleCarry(rows);
  isolateSerializedForegroundOpacity(rows, startLine, getSerializedCell);
  const renderedStyle = getComputedStyle(renderedRows);
  const serializedRowCount = rows.childElementCount;
  Object.assign(rows.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    height: `${serializedRowCount * rowHeight}px`,
    fontFamily: renderedStyle.fontFamily,
    fontSize: renderedStyle.fontSize,
    fontWeight: renderedStyle.fontWeight,
    fontVariantLigatures: renderedStyle.fontVariantLigatures,
    letterSpacing: renderedStyle.letterSpacing,
    whiteSpace: "pre",
  });

  for (const row of Array.from(rows.children)) {
    if (!(row instanceof HTMLElement)) continue;
    Object.assign(row.style, {
      height: `${rowHeight}px`,
      lineHeight: `${rowHeight}px`,
      overflow: "hidden",
      whiteSpace: "pre",
    });
  }
  return rows;
}

/**
 * Renders the single derived history layer used around xterm's server-owned viewport.
 *
 * `review` freezes the rows the user is reading. `live-backfill` paints the real
 * rows immediately preceding a short, bottom-aligned live viewport. Both are
 * projections of xterm's buffer, never independent scroll state, and this
 * renderer owns exactly one projection node at a time.
 */
export function attachPtyHistoryProjection(
  host: HTMLElement,
  options: PtyHistoryProjectionOptions = {},
): PtyHistoryProjectionController {
  let renderedProjection: HTMLElement | null = null;
  const initialHostOverflow = host.style.overflow;

  const replaceProjection = (next: HTMLElement): void => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const selection = Array.from(screen.children).find(
      (child) => child instanceof HTMLElement && child.classList.contains("xterm-selection"),
    );
    screen.insertBefore(next, selection ?? null);
    renderedProjection?.remove();
    renderedProjection = next;
    host.style.overflow = "visible";
  };

  const clear = (): void => {
    renderedProjection?.remove();
    renderedProjection = null;
    host.style.overflow = initialHostOverflow;
  };

  const render = (projection: PtyHistoryProjection | null): boolean => {
    if (!projection) {
      clear();
      return true;
    }
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const renderedRows = screen ? findRenderedRows(screen) : null;
    if (
      !screen ||
      !renderedRows ||
      !options.serializeRangeAsHtml ||
      projection.endLine < projection.startLine ||
      projection.rowHeight <= 0
    ) {
      return false;
    }

    const html = options.serializeRangeAsHtml(projection.startLine, projection.endLine);
    const rows = createSerializedRows(
      html,
      renderedRows,
      projection.rowHeight,
      projection.startLine,
      options.getSerializedCell,
    );
    if (!rows) return false;
    const slot = projection.kind === "review" ? REVIEW_SLOT : LIVE_BACKFILL_SLOT;
    const capturedRowIdentityOffset = options.getBufferRowIdentityOffset?.() ?? 0;
    const next = createSnapshotShell(
      screen,
      rows,
      projection.topOffset,
      slot,
      projection.startLine,
      projection.endLine,
      capturedRowIdentityOffset,
    );
    const frozenLines = new Map<number, IBufferLine>();
    if (options.getSelectionLine) {
      for (let line = projection.startLine; line <= projection.endLine; line += 1) {
        const sourceLine = options.getSelectionLine(line);
        if (sourceLine) {
          frozenLines.set(line, snapshotPtySelectionBufferLine(sourceLine, sourceLine.length));
        }
      }
    }
    projectionSelectionLines.set(next, {
      capturedRowIdentityOffset,
      getCurrentRowIdentityOffset: options.getBufferRowIdentityOffset,
      lines: frozenLines,
    });
    replaceProjection(next);
    return true;
  };

  return {
    render,
    dispose: clear,
  };
}
