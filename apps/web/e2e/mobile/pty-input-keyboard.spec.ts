// 移动端 PTY 输入路径 e2e (commit 1864a268 防回归):
// 1. cold-start 进会话 textarea 不该 auto-focus (避免触屏立刻弹软键盘),
// 2. 用户主动点 PTY 后才 focus,
// 3. focus 后基础输入 + Enter 落到 raw input.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";

const SESSION_ID = "mobile-pty-input";

test.describe("L4 mobile / PTY input + soft keyboard discipline", () => {
  test.setTimeout(60_000);

  test("does not auto-focus terminal on cold-start; main user tap focuses + sends input", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    // cold-start: textarea 不应该自动 focus, 否则 Android 系统软键盘立刻弹起.
    const initialFocus = await emuPage.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    );
    expect(initialFocus).not.toBe("Terminal input");

    // 用户主动点 PTY 容器, textarea 才接管 focus.
    await emuPage.locator('[data-slot="pty-terminal"]').click();
    await expect
      .poll(() => emuPage.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");

    // 输入 + 回车. 移动端 PTY 走 touch-editing 路径, Enter 派 \n 而非 \r.
    await emuPage.keyboard.type("abc");
    await emuPage.keyboard.press("Enter");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("abc");
  });

  test("preserves IME-transformed full-width punctuation on emu Chrome", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    const input = emuPage.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await emuPage.locator('[data-slot="pty-terminal"]').click();
    await expect(input).toBeFocused();

    await input.evaluate((el) => {
      el.dispatchEvent(
        new InputEvent("input", {
          data: "，",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("，");
  });
});
