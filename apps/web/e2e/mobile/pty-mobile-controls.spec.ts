// PTY 移动端软控制按键全流程在真 emu 上: esc / clear / 上下左右 / enter 都正确发出 raw input.
// L2 mobile-contract pty test 只验证 terminal visible, L4 钉死全部按键的 raw 序列.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";
import { tapWithAdb, touchPtyTerminalAndWaitForSoftKeyboard } from "./pty-soft-keyboard";

const SESSION_ID = "mobile-pty-controls";

test.describe("L4 mobile / PTY soft controls full key sequence", () => {
  test.setTimeout(60_000);

  test("esc / clear / arrows / enter buttons emit correct raw escape sequences", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    // 触屏检测必须为 true 才显示 mobile controls. emu Chrome 默认 pointer:coarse.
    const isTouchSurface = await emuPage.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );
    expect(isTouchSurface).toBe(true);

    // 软控制区只在系统软键盘实际打开后出现。
    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
    const controls = emuPage.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();

    // esc (\x1b) + clear input area (\x1b\x1b) + 左 (\x1b[D) + 右 (\x1b[C) + 上 (\x1b[A) + 下 (\x1b[B) + ^S (\x13) + enter (\r).
    let expectedRawInput = "";
    for (const [slot, input] of [
      ["pty-mobile-key-esc", "\x1b"],
      ["pty-mobile-key-clear", "\x1b\x1b"],
      ["pty-mobile-key-left", "\x1b[D"],
      ["pty-mobile-key-right", "\x1b[C"],
      ["pty-mobile-key-up", "\x1b[A"],
      ["pty-mobile-key-down", "\x1b[B"],
      ["pty-mobile-key-ctrl-s", "\x13"],
      ["pty-mobile-key-enter", "\r"],
    ] as const) {
      await tapWithAdb(emuPage.locator(`[data-slot="${slot}"]`));
      expectedRawInput += input;
      await expect.poll(() => readRawPtyInput(emuPage)).toBe(expectedRawInput);
    }

    expect(expectedRawInput).toBe("\x1b\x1b\x1b\x1b[D\x1b[C\x1b[A\x1b[B\x13\r");
  });
});
