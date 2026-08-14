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
}

const REVIEW_SLOT = "pty-review-snapshot";
const LIVE_BACKFILL_SLOT = "pty-live-backfill";

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
): HTMLElement {
  const next = document.createElement("div");
  next.dataset.slot = slot;
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

function isolateSerializedForegroundOpacity(rows: HTMLElement): void {
  for (const cell of rows.querySelectorAll<HTMLElement>("span[style]")) {
    const opacity = cell.style.opacity;
    if (!opacity || opacity === "1") continue;

    // SerializeAddon represents xterm's dim attribute by fading the whole cell.
    // The live renderer fades only glyphs, so isolate that opacity from the
    // cell background to keep review snapshots visually identical.
    cell.style.removeProperty("opacity");
    const foreground = document.createElement("span");
    foreground.style.opacity = opacity;
    foreground.append(...Array.from(cell.childNodes));
    cell.append(foreground);
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
): HTMLElement | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const serializedRows = parsed.querySelector<HTMLElement>("pre > div");
  if (!serializedRows) return null;

  const rows = document.importNode(serializedRows, true);
  rows.className = renderedRows.className;
  rows.removeAttribute("id");
  restoreSerializedRowStyleCarry(rows);
  isolateSerializedForegroundOpacity(rows);
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
    const rows = createSerializedRows(html, renderedRows, projection.rowHeight);
    if (!rows) return false;
    const slot = projection.kind === "review" ? REVIEW_SLOT : LIVE_BACKFILL_SLOT;
    const next = createSnapshotShell(screen, rows, projection.topOffset, slot);
    replaceProjection(next);
    return true;
  };

  return {
    render,
    dispose: clear,
  };
}
