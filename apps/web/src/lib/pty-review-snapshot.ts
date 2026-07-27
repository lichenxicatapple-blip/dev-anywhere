interface PtyReviewSnapshotController {
  captureRange: (startLine: number, rowCount: number) => boolean;
  clear: () => void;
  dispose: () => void;
}

interface PtyReviewSnapshotOptions {
  serializeRangeAsHtml?: (startLine: number, endLine: number) => string;
}

const SNAPSHOT_SLOT = "pty-review-snapshot";

function findRenderedRows(screen: HTMLElement): HTMLElement | null {
  return (
    Array.from(screen.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("xterm-rows") &&
        child.dataset.slot !== SNAPSHOT_SLOT,
    ) ?? null
  );
}

function createSnapshotShell(screen: HTMLElement, rows: HTMLElement): HTMLElement {
  const next = document.createElement("div");
  next.dataset.slot = SNAPSHOT_SLOT;
  next.setAttribute("aria-hidden", "true");
  Object.assign(next.style, {
    position: "absolute",
    top: "0",
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

function createSerializedRows(
  html: string,
  renderedRows: HTMLElement,
  rowCount: number,
): HTMLElement | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const serializedRows = parsed.querySelector<HTMLElement>("pre > div");
  if (!serializedRows) return null;

  const rows = document.importNode(serializedRows, true);
  rows.className = renderedRows.className;
  rows.removeAttribute("id");
  isolateSerializedForegroundOpacity(rows);
  const renderedStyle = getComputedStyle(renderedRows);
  const rowHeight = rowCount > 0 ? renderedRows.clientHeight / rowCount : 0;
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
 * Keeps the visible PTY frame coherent while the user reviews history.
 *
 * xterm's DOM renderer reuses the same row elements for scrollback and the
 * mutable live screen. The controller serializes the requested buffer rows
 * before moving the live viewport, then clears that visual snapshot when live
 * following resumes. The real terminal keeps receiving and parsing data.
 */
export function attachPtyReviewSnapshot(
  host: HTMLElement,
  options: PtyReviewSnapshotOptions = {},
): PtyReviewSnapshotController {
  let snapshot: HTMLElement | null = null;
  const initialHostOverflow = host.style.overflow;

  const replaceSnapshot = (next: HTMLElement): void => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const selection = Array.from(screen.children).find(
      (child) => child instanceof HTMLElement && child.classList.contains("xterm-selection"),
    );
    screen.insertBefore(next, selection ?? null);
    snapshot?.remove();
    snapshot = next;
    host.style.overflow = "visible";
  };

  const clear = (): void => {
    snapshot?.remove();
    snapshot = null;
    host.style.overflow = initialHostOverflow;
  };

  const captureRange = (startLine: number, rowCount: number): boolean => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const renderedRows = screen ? findRenderedRows(screen) : null;
    if (!screen || !renderedRows || !options.serializeRangeAsHtml || rowCount <= 0) return false;

    // One extra buffer row keeps the bottom covered while native scrolling sits
    // between xterm's integer viewport rows. It is visual overscan only; the
    // server-owned PTY geometry remains unchanged.
    const html = options.serializeRangeAsHtml(startLine, startLine + rowCount);
    const rows = createSerializedRows(html, renderedRows, rowCount);
    if (!rows) return false;
    replaceSnapshot(createSnapshotShell(screen, rows));
    return true;
  };

  return {
    captureRange,
    clear,
    dispose: clear,
  };
}
