// 真 Android Chrome: 长 PTY 输入期间, 水平/纵向滚动都可能被浏览器输入法布局改写。
// 这些 case 保护输入区始终可见, 且 Enter 提交后能立刻回到行首。
import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import {
  ptyInput,
  ptyTerminal,
  readPtyDebugSnapshot,
  readPtyHorizontalScrollMetrics,
  resizePty,
  sendPtyLines,
  sendPtyOutput,
} from "../pty-scroll-helpers";

const SESSION_ID = "mobile-pty-horizontal-scroll";

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

test.describe("L4 mobile / PTY input scroll", () => {
  test.setTimeout(60_000);

  test("touch-drag pans horizontally when the PTY overflows the mobile viewport", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-touch-pan`;
    await emuPage.addInitScript(() => {
      localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
    });
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 80, 24);
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.maxScrollLeft))
      .toBeGreaterThan(100);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    await touchDrag(
      emuPage,
      { x: box.x + box.width - 24, y: box.y + box.height * 0.55 },
      { x: box.x + 24, y: box.y + box.height * 0.55 },
    );

    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(80);
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__devAnywherePtyScrollTrace ?? []).some(
            (entry) => entry.event === "touchmove:horizontal-native",
          ),
        ),
      )
      .toBe(true);
  });

  test("keeps following the cursor after Chrome nudges scrollLeft while typing", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: `${SESSION_ID}-nudge`, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTestPtyTerminals?.get(sid)?.cols ?? 0,
          `${SESSION_ID}-nudge`,
        ),
      )
      .toBe(270);

    await ptyTerminal(emuPage).click();
    await expect(ptyInput(emuPage)).toBeFocused();
    await ptyTerminal(emuPage).evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollLeft = 28;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await sendPtyOutput(emuPage, "x".repeat(90));

    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(100);
  });

  test("resets horizontal scroll to line start immediately after Enter on a long line", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols ?? 0, SESSION_ID),
      )
      .toBe(270);

    await ptyTerminal(emuPage).click();
    await expect(ptyInput(emuPage)).toBeFocused();

    await sendPtyOutput(emuPage, `LONG ${"x".repeat(140)}`);
    await expect
      .poll(() =>
        readPtyHorizontalScrollMetrics(emuPage).then(
          (metrics) => metrics.scrollWidth - metrics.clientWidth,
        ),
      )
      .toBeGreaterThan(400);
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(0);

    await emuPage.keyboard.press("Enter");

    await expect.poll(() => readRawPtyInput(emuPage)).toContain("\n");
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeLessThanOrEqual(1);
  });

  test("keeps vertical follow after raw input when Chrome reports a layout scroll", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-vertical-drift`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0, sessionId),
      )
      .toBe(52);
    await sendPtyLines(emuPage, { count: 160, prefix: "fill" });

    await ptyTerminal(emuPage).click();
    await expect(ptyInput(emuPage)).toBeFocused();
    await emuPage.keyboard.type("x");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("x");
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((snapshot) => snapshot?.verticalIntent.mode))
      .toBe("following");

    await ptyTerminal(emuPage).evaluate((el) => {
      const node = el as HTMLElement;
      const bottom =
        window.__devAnywherePtyDebug?.()?.anchor.bottomScrollTop ??
        Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(0, bottom - 240);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((snapshot) => snapshot?.verticalIntent.mode))
      .toBe("following");
    await expect
      .poll(() =>
        readPtyDebugSnapshot(emuPage).then((snapshot) =>
          snapshot ? Math.abs(snapshot.anchor.scrollTopDeltaToBottom) : Number.POSITIVE_INFINITY,
        ),
      )
      .toBeLessThanOrEqual(8);
  });
});
