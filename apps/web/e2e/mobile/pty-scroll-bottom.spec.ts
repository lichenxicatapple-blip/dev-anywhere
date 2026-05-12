// 真 Android emu 上 PTY 模式滚动 + back-to-bottom 触屏交互:
// 1. 灌长 buffer 后滚到顶, back-to-bottom 出现, tap 后回底,
// 2. 滚到上方 (远离 bottom) 期间新输出不抢回底, "有新消息" 浮起.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-pty-scroll";

test.describe("L4 mobile / PTY scroll back-to-bottom", () => {
  test.setTimeout(60_000);

  test("scroll up shows back-to-bottom; tap returns to bottom", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 120 }, (_, i) => `line ${String(i).padStart(3, "0")}\r\n`).join(""),
      );
    });

    const terminal = emuPage.locator('[data-slot="pty-terminal"]');
    await terminal.evaluate((el) => {
      (el as HTMLElement).scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });

    const backToBottom = emuPage.locator('[data-slot="back-to-bottom"]');
    await expect(backToBottom).toBeVisible();

    await backToBottom.click();
    await expect(backToBottom).toHaveJSProperty("inert", true);
    await expect
      .poll(() =>
        terminal.evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollHeight - node.clientHeight - node.scrollTop;
        }),
      )
      .toBeLessThanOrEqual(8);
  });

  test("new PTY output while scrolled up surfaces 有新消息 indicator without snapping to bottom", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 120 }, (_, i) => `line ${String(i).padStart(3, "0")}\r\n`).join(""),
      );
    });

    const terminal = emuPage.locator('[data-slot="pty-terminal"]');
    await terminal.evaluate((el) => {
      (el as HTMLElement).scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(emuPage.locator('[data-slot="back-to-bottom"]')).toBeVisible();
    const beforeScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);

    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty("frame-while-user-scrolled-up\r\n");
    });

    await expect(emuPage.locator('[data-slot="back-to-bottom-new-indicator"]')).toBeVisible();
    const afterScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(afterScrollTop).toBeLessThanOrEqual(beforeScrollTop + 8);
  });
});
