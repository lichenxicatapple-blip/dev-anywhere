import { expect, type Locator, type Page } from "@playwright/test";

export const PTY_BOTTOM_THRESHOLD_PX = 8;

export interface PtyScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  bottomGap: number;
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

export async function scrollPtyToTop(
  page: Page,
  options: { wheelDeltaY?: number } = {},
): Promise<void> {
  await ptyTerminal(page).evaluate((el, wheelDeltaY) => {
    if (typeof wheelDeltaY === "number") {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: wheelDeltaY }));
    }
    const node = el as HTMLElement;
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, options.wheelDeltaY);
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
  await expect
    .poll(() => readPtyScrollMetrics(page).then((metrics) => metrics.bottomGap))
    .toBeLessThanOrEqual(thresholdPx);
}

export async function expectBackToBottomClearance(
  page: Page,
  options: { touchEditingSurface: boolean },
): Promise<void> {
  const backToBottomScrollbarGap = async () => {
    const button = await backToBottom(page).boundingBox();
    const scrollbar = await ptyScrollbar(page).boundingBox();
    if (!button || !scrollbar) return -1;
    return Math.round(scrollbar.x - (button.x + button.width));
  };
  const backToBottomViewportGap = async () => {
    const button = await backToBottom(page).boundingBox();
    const viewport = page.viewportSize();
    if (!button || !viewport) return -1;
    return Math.round(viewport.width - (button.x + button.width));
  };

  if (options.touchEditingSurface) {
    await expect.poll(backToBottomViewportGap).toBeGreaterThanOrEqual(20);
    await expect.poll(backToBottomViewportGap).toBeLessThanOrEqual(32);
    return;
  }

  await expect.poll(backToBottomScrollbarGap).toBeGreaterThanOrEqual(12);
  await expect.poll(backToBottomScrollbarGap).toBeLessThanOrEqual(20);
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
