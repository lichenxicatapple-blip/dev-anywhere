// 真 Android emu 上 PTY 模式滚动 + back-to-bottom 触屏交互:
// 1. 灌长 buffer 后滚到顶, back-to-bottom 出现, tap 后回底,
// 2. 滚到上方 (远离 bottom) 期间新输出不抢回底, "有新消息" 浮起.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  expectPtyAtBottom,
  readPtyScrollMetrics,
  scrollPtyToTop,
  sendPtyLines,
  sendPtyOutput,
} from "../pty-scroll-helpers";

const SESSION_ID = "mobile-pty-scroll";

test.describe("L4 mobile / PTY scroll back-to-bottom", () => {
  test.setTimeout(60_000);

  test("scroll up shows back-to-bottom; tap returns to bottom", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });

    await scrollPtyToTop(emuPage);

    const button = backToBottom(emuPage);
    await expect(button).toBeVisible();

    await button.click();
    await expect(button).toHaveJSProperty("inert", true);
    await expectPtyAtBottom(emuPage);
  });

  test("new PTY output while scrolled up surfaces 有新消息 indicator without snapping to bottom", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });

    await scrollPtyToTop(emuPage);
    await expect(backToBottom(emuPage)).toBeVisible();
    const beforeScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;

    await sendPtyOutput(emuPage, "frame-while-user-scrolled-up\r\n");

    await expect(backToBottomNewIndicator(emuPage)).toBeVisible();
    const afterScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;
    expect(afterScrollTop).toBeLessThanOrEqual(beforeScrollTop + 8);
  });
});
