// 真 Android emu 上 PTY 模式滚动 + back-to-bottom 触屏交互:
// 1. 灌长 buffer 后滚到顶, back-to-bottom 出现, tap 后回底,
// 2. 滚到上方 (远离 bottom) 期间新输出不抢回底, "有新消息" 浮起.
import type { Locator, Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  enterLongHostMode,
  expectPtyAtBottom,
  expectPtyCursorAwareBottom,
  expectPtyScrollable,
  ptyTerminal,
  readPtyDebugSnapshot,
  readPtyScrollMetrics,
  scrollPtyToTop,
  sendPtyLines,
  sendPtyOutput,
} from "../pty-scroll-helpers";

const SESSION_ID = "mobile-pty-scroll";

async function touchTap(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("tap target is not visible");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(60);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

async function touchDrag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    for (let step = 1; step <= 4; step += 1) {
      const progress = step / 4;
      await page.waitForTimeout(40);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          },
        ],
      });
    }
    await page.waitForTimeout(60);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach();
  }
}

async function readPtyScreenBottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    if (!container || !screen) return Number.POSITIVE_INFINITY;
    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const paddingBottom = Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
    return containerRect.bottom - paddingBottom - screenRect.bottom;
  });
}

test.describe("L4 mobile / PTY scroll back-to-bottom", () => {
  test.setTimeout(60_000);

  test("PTY screen covers the mobile scroll viewport without a full-row bottom blank", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyAtBottom(emuPage);

    await expect.poll(() => readPtyScreenBottomGap(emuPage)).toBeLessThanOrEqual(8);
  });

  test("scroll up shows back-to-bottom; tap returns to bottom", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyScrollable(emuPage, 200);

    await scrollPtyToTop(emuPage);
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);

    const button = backToBottom(emuPage);
    await expect(button).toBeVisible();
    await expect(button).toHaveJSProperty("inert", false);

    await touchTap(emuPage, button);
    await expectPtyAtBottom(emuPage);
    await expect(button).toHaveJSProperty("inert", true);
  });

  test("small upward touch at semantic bottom does not jump to previous page", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-bottom-touch-drift`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 120, rows: 54 });
    await sendPtyLines(emuPage, { count: 260, prefix: "bottom-drift" });
    await expectPtyCursorAwareBottom(emuPage);
    const beforeSnapshot = await readPtyDebugSnapshot(emuPage);
    if (!beforeSnapshot) throw new Error("PTY debug snapshot is not available");

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await touchDrag(emuPage, { x, y }, { x, y: y - 36 });

    await expectPtyCursorAwareBottom(emuPage, 12);
    const afterSnapshot = await readPtyDebugSnapshot(emuPage);
    if (!afterSnapshot) throw new Error("PTY debug snapshot is not available");
    expect(afterSnapshot.container.scrollTop).toBeGreaterThanOrEqual(
      beforeSnapshot.container.scrollTop - 32,
    );
  });

  test("new PTY output while scrolled up surfaces 有新消息 indicator without snapping to bottom", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyScrollable(emuPage, 200);

    await scrollPtyToTop(emuPage);
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);
    await expect(backToBottom(emuPage)).toBeVisible();
    const beforeScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;

    await sendPtyOutput(emuPage, "frame-while-user-scrolled-up\r\n");

    await expect(backToBottomNewIndicator(emuPage)).toBeVisible();
    const afterScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;
    expect(afterScrollTop).toBeLessThanOrEqual(beforeScrollTop + 8);
  });
});
