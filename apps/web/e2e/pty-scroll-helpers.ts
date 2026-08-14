import { expect, type Locator, type Page } from "@playwright/test";
import type { PtyDebugSnapshot } from "../src/lib/pty-debug-snapshot";

export const PTY_BOTTOM_THRESHOLD_PX = 8;

export interface PtyScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  bottomGap: number;
}

export interface PtyHorizontalScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  maxScrollLeft: number;
  rightGap: number;
}

export interface PtyRenderedGeometry {
  anchorAtBottom: boolean;
  liveBackfillRequired: boolean;
  paintedTopGap: number;
  cursorInViewport: boolean;
  hostTopDrift: number;
  pendingContainerSyncRetry: boolean;
  reviewSnapshotIntersectsContainer: boolean;
  reviewSnapshotPresent: boolean;
  screenIntersectsContainer: boolean;
  scrollTopDeltaToBottom: number;
  viewportHostCoverage: number;
}

export function ptyTerminal(page: Page): Locator {
  return page.locator('[data-slot="pty-terminal"]');
}

export function ptyInput(page: Page): Locator {
  return page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
}

export function ptyScrollbar(page: Page): Locator {
  return page.locator('[data-slot="pty-scrollbar"]');
}

export function backToBottom(page: Page): Locator {
  return page.locator('[data-slot="back-to-bottom"]');
}

export function backToBottomNewIndicator(page: Page): Locator {
  return page.locator('[data-slot="back-to-bottom-new-indicator"]');
}

export function ptyApprovalHint(page: Page): Locator {
  return page.locator('[data-slot="pty-approval-hint"]');
}

export async function sendPtyOutput(page: Page, data: string): Promise<void> {
  await page.evaluate((payload) => {
    window.__ptySmoke.sendPty(payload);
  }, data);
}

export async function sendPtyLines(
  page: Page,
  options: { count: number; prefix?: string; pad?: number },
): Promise<void> {
  const { count, prefix = "line", pad = 3 } = options;
  await page.evaluate(
    ({ lineCount, linePrefix, linePad }) => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: lineCount },
          (_, i) => `${linePrefix} ${String(i).padStart(linePad, "0")}\r\n`,
        ).join(""),
      );
    },
    { lineCount: count, linePrefix: prefix, linePad: pad },
  );
}

export async function resizePty(page: Page, cols: number, rows: number): Promise<void> {
  await page.evaluate(
    ({ nextCols, nextRows }) => {
      window.__ptySmoke.resize(nextCols, nextRows);
    },
    { nextCols: cols, nextRows: rows },
  );
}

export async function setPtyState(
  page: Page,
  state: "working" | "turn_complete" | "approval_wait",
): Promise<void> {
  await page.evaluate((nextState) => {
    window.__ptySmoke.setPtyState(nextState);
  }, state);
}

export async function readPtyScrollMetrics(page: Page): Promise<PtyScrollMetrics> {
  return ptyTerminal(page).evaluate((el) => {
    const node = el as HTMLElement;
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    return {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      maxScrollTop,
      bottomGap: maxScrollTop - node.scrollTop,
    };
  });
}

export async function readPtyHorizontalScrollMetrics(
  page: Page,
): Promise<PtyHorizontalScrollMetrics> {
  return ptyTerminal(page).evaluate((el) => {
    const node = el as HTMLElement;
    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    return {
      scrollLeft: node.scrollLeft,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      maxScrollLeft,
      rightGap: maxScrollLeft - node.scrollLeft,
    };
  });
}

export async function readPtyDebugSnapshot(page: Page): Promise<PtyDebugSnapshot | null> {
  return page.evaluate(() => window.__devAnywherePtyDebug?.() ?? null);
}

export async function readPtyRenderedGeometry(page: Page): Promise<PtyRenderedGeometry | null> {
  return page.evaluate(() => {
    const container =
      document.querySelector<HTMLElement>(
        '[data-slot="pty-keepalive-entry"][data-active="true"] [data-slot="pty-terminal"]',
      ) ?? document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = container?.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    const reviewSnapshot = screen?.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    const liveBackfill = screen?.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    const snapshot = window.__devAnywherePtyDebug?.();
    if (!container || !screen || !snapshot) return null;

    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const reviewSnapshotRect = reviewSnapshot?.getBoundingClientRect() ?? null;
    const liveBackfillRect = liveBackfill?.getBoundingClientRect() ?? null;
    const style = getComputedStyle(container);
    const contentTop = containerRect.top + (Number.parseFloat(style.paddingTop) || 0);
    const rawLiveTopGap = Math.max(0, screenRect.top - contentTop);
    const paintedTop = Math.min(screenRect.top, liveBackfillRect?.top ?? screenRect.top);
    return {
      anchorAtBottom: snapshot.anchor.atBottom,
      liveBackfillRequired:
        rawLiveTopGap > 1 && snapshot.term.viewportY * snapshot.cell.h >= rawLiveTopGap,
      paintedTopGap: Math.max(0, paintedTop - contentTop),
      cursorInViewport: snapshot.anchor.cursorInViewport,
      hostTopDrift: snapshot.host.topDrift,
      pendingContainerSyncRetry: snapshot.pendingContainerSyncRetry,
      reviewSnapshotIntersectsContainer:
        reviewSnapshotRect !== null &&
        reviewSnapshotRect.width > 0 &&
        reviewSnapshotRect.height > 0 &&
        reviewSnapshotRect.right > containerRect.left &&
        reviewSnapshotRect.left < containerRect.right &&
        reviewSnapshotRect.bottom > containerRect.top &&
        reviewSnapshotRect.top < containerRect.bottom,
      reviewSnapshotPresent: reviewSnapshot !== null,
      screenIntersectsContainer:
        screenRect.width > 0 &&
        screenRect.height > 0 &&
        screenRect.right > containerRect.left &&
        screenRect.left < containerRect.right &&
        screenRect.bottom > containerRect.top &&
        screenRect.top < containerRect.bottom,
      scrollTopDeltaToBottom: snapshot.anchor.scrollTopDeltaToBottom,
      viewportHostCoverage: snapshot.viewportHostCoverage,
    };
  });
}

function renderedGeometryFailure(
  geometry: PtyRenderedGeometry | null,
  options: { bottomThresholdPx?: number } = {},
): string {
  if (!geometry) return "geometry-unavailable";
  if (geometry.pendingContainerSyncRetry) return "container-sync-pending";
  if (geometry.reviewSnapshotPresent) {
    if (!geometry.reviewSnapshotIntersectsContainer) return "review-snapshot-outside-container";
    if (options.bottomThresholdPx !== undefined) return "review-snapshot-at-semantic-bottom";
    return "ready";
  }
  if (Math.abs(geometry.hostTopDrift) > 1) {
    return `host-top-drift:${geometry.hostTopDrift}`;
  }
  if (!geometry.screenIntersectsContainer) return "screen-outside-container";
  if (geometry.viewportHostCoverage <= 0) {
    return `host-outside-viewport:${geometry.viewportHostCoverage}`;
  }
  if (options.bottomThresholdPx === undefined) return "ready";
  if (geometry.liveBackfillRequired && geometry.paintedTopGap > options.bottomThresholdPx) {
    return `painted-top-gap:${geometry.paintedTopGap}`;
  }
  if (!geometry.anchorAtBottom) return "semantic-bottom:false";
  if (!geometry.cursorInViewport) return "cursor-in-viewport:false";
  if (Math.abs(geometry.scrollTopDeltaToBottom) > options.bottomThresholdPx) {
    return `bottom-delta:${geometry.scrollTopDeltaToBottom}`;
  }
  return "ready";
}

export async function expectPtyRendered(page: Page): Promise<void> {
  await expect
    .poll(async () => renderedGeometryFailure(await readPtyRenderedGeometry(page)))
    .toBe("ready");
}

export async function scrollPtyToTop(
  page: Page,
  options: { wheelDeltaY?: number } = {},
): Promise<void> {
  await ptyTerminal(page).evaluate((el, wheelDeltaY) => {
    const node = el as HTMLElement;
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const requestedDelta = typeof wheelDeltaY === "number" ? wheelDeltaY : -maxScrollTop;
    // Always travel far enough to reach the top, but enter review through the
    // controller-owned wheel path. Assigning scrollTop before a synthetic
    // scroll event pairs the moved DOM with xterm's previous painted viewport.
    const deltaY = Math.min(requestedDelta, -maxScrollTop);
    el.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
      }),
    );
  }, options.wheelDeltaY);

  await expectPtyRendered(page);
}

export async function expectPtyScrollable(page: Page, minMaxScrollTop = 0): Promise<void> {
  await expect
    .poll(() => readPtyScrollMetrics(page).then((metrics) => metrics.maxScrollTop))
    .toBeGreaterThan(minMaxScrollTop);
}

export async function expectPtyAtBottom(
  page: Page,
  thresholdPx = PTY_BOTTOM_THRESHOLD_PX,
): Promise<void> {
  await expectPtyCursorAwareBottom(page, thresholdPx);
}

export async function expectPtyCursorAwareBottom(
  page: Page,
  thresholdPx = PTY_BOTTOM_THRESHOLD_PX,
): Promise<void> {
  await expect
    .poll(async () =>
      renderedGeometryFailure(await readPtyRenderedGeometry(page), {
        bottomThresholdPx: thresholdPx,
      }),
    )
    .toBe("ready");
}

export async function expectBackToBottomClearance(
  page: Page,
  options: { touchEditingSurface: boolean },
): Promise<void> {
  const backToBottomViewportGap = async () => {
    const button = await backToBottom(page).boundingBox();
    const viewport = page.viewportSize();
    if (!button || !viewport) return -1;
    return Math.round(viewport.width - (button.x + button.width));
  };

  if (options.touchEditingSurface) {
    await expect.poll(backToBottomViewportGap).toBeGreaterThanOrEqual(18);
    await expect.poll(backToBottomViewportGap).toBeLessThanOrEqual(32);
    return;
  }

  await expect.poll(backToBottomViewportGap).toBeGreaterThanOrEqual(20);
  await expect.poll(backToBottomViewportGap).toBeLessThanOrEqual(32);
}

export async function enterLongHostMode(
  page: Page,
  options: { sessionId: string; cols?: number; rows?: number },
): Promise<void> {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 60;
  await resizePty(page, cols, rows);
  await expect
    .poll(() =>
      page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0, options.sessionId),
    )
    .toBe(rows);
}

export async function expectPtySessionSubscribeCount(page: Page, minCount: number): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__ptySmoke.sent.filter((raw) => {
            try {
              return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
            } catch {
              return false;
            }
          }).length,
      ),
    )
    .toBeGreaterThanOrEqual(minCount);
}
