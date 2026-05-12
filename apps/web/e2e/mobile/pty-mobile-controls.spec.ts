// PTY 移动端软控制按键全流程在真 emu 上: clear / 上下左右 / enter 都正确发出 raw input.
// L2 mobile-contract pty test 只验证 terminal visible, L4 钉死全部按键的 raw 序列.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";

const SESSION_ID = "mobile-pty-controls";

test.describe("L4 mobile / PTY soft controls full key sequence", () => {
  test.setTimeout(60_000);

  test("clear / arrows / enter buttons emit correct raw escape sequences", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    // 触屏检测必须为 true 才显示 mobile controls. emu Chrome 默认 pointer:coarse.
    const isTouchSurface = await emuPage.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );
    expect(isTouchSurface).toBe(true);

    // focus 终端让 mobile-controls 浮起.
    await emuPage.locator('[data-slot="pty-terminal"]').click();
    const controls = emuPage.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();

    // clear (\x15) + 左 (\x1b[D) + 右 (\x1b[C) + 上 (\x1b[A) + 下 (\x1b[B) + enter (\r).
    await emuPage.locator('[data-slot="pty-mobile-key-clear"]').click();
    await emuPage.locator('[data-slot="pty-mobile-key-left"]').click();
    await emuPage.locator('[data-slot="pty-mobile-key-right"]').click();
    await emuPage.locator('[data-slot="pty-mobile-key-up"]').click();
    await emuPage.locator('[data-slot="pty-mobile-key-down"]').click();
    await emuPage.locator('[data-slot="pty-mobile-key-enter"]').click();

    await expect
      .poll(() => readRawPtyInput(emuPage))
      .toContain("\x15\x1b[D\x1b[C\x1b[A\x1b[B\r");
  });
});
