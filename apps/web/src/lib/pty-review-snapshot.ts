interface PtyReviewSnapshotController {
  capture: () => boolean;
  clear: () => void;
  dispose: () => void;
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

function removeActiveCursorStyle(rows: HTMLElement): void {
  for (const cursor of rows.querySelectorAll<HTMLElement>('[class*="xterm-cursor"]')) {
    for (const className of Array.from(cursor.classList)) {
      if (className.startsWith("xterm-cursor")) cursor.classList.remove(className);
    }
  }
  rows.classList.remove("xterm-focus");
}

/**
 * Keeps the visible PTY frame coherent while the user reviews history.
 *
 * xterm's DOM renderer reuses the same row elements for scrollback and the
 * mutable live screen. A viewport that crosses baseY can therefore show a
 * static upper half and a repainting lower half. This controller snapshots the
 * rendered row layer only; the real terminal keeps receiving and parsing data.
 * The scroll controller replaces the snapshot after deliberate user
 * navigation and clears it when live following resumes.
 */
export function attachPtyReviewSnapshot(host: HTMLElement): PtyReviewSnapshotController {
  let snapshot: HTMLElement | null = null;

  const clear = (): void => {
    snapshot?.remove();
    snapshot = null;
  };

  const capture = (): boolean => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return false;
    const renderedRows = findRenderedRows(screen);
    if (!renderedRows) return false;

    const rows = renderedRows.cloneNode(true) as HTMLElement;
    removeActiveCursorStyle(rows);

    const next = document.createElement("div");
    next.dataset.slot = SNAPSHOT_SLOT;
    next.setAttribute("aria-hidden", "true");
    Object.assign(next.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      backgroundColor: getComputedStyle(screen).backgroundColor,
    });
    next.append(rows);

    const selection = Array.from(screen.children).find(
      (child) => child instanceof HTMLElement && child.classList.contains("xterm-selection"),
    );
    screen.insertBefore(next, selection ?? null);
    snapshot?.remove();
    snapshot = next;
    return true;
  };

  return {
    capture,
    clear,
    dispose: clear,
  };
}
