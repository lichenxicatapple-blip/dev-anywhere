// PTY 移动端软控制按键长按 repeat: 持续按住方向键应连续发送 raw 序列
// (实现节奏: 首发立即, 300ms hold 后, 之后 50ms 一次稳定 repeat).
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";
import { touchPtyTerminalAndWaitForSoftKeyboard } from "./pty-soft-keyboard";

const SESSION_ID = "mobile-pty-repeat";

test.describe("L4 mobile / PTY soft controls long-press repeat", () => {
  test.setTimeout(60_000);

  test("holding the left arrow button emits multiple ESC[D sequences", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    if (!(await touchPtyTerminalAndWaitForSoftKeyboard(emuPage))) {
      test.skip(true, "Android emulator did not expose a soft-keyboard visualViewport resize");
    }
    const left = emuPage.locator('[data-slot="pty-mobile-key-left"]');
    await expect(left).toBeVisible();

    // 直接派 PointerEvent (emu Chrome 上 Playwright mouse.down/up 不一定能触发 React
    // onPointerDown 的 hold 流程, dispatchEvent 显式派事件最可靠).
    await left.evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          buttons: 1,
        }),
      ),
    );
    try {
      // raw input 应包含至少 3 次 ESC[D (1 首发 + hold 后多次 repeat). 这里按住期间
      // 轮询, 不用固定 sleep 卡边界, 避免 Android emu 在负载下 timer 稍慢时首跑 flaky。
      await expect
        .poll(
          async () => {
            const raw = await readRawPtyInput(emuPage);
            return raw.split("[D").length - 1;
          },
          { timeout: 1_500 },
        )
        .toBeGreaterThanOrEqual(3);
    } finally {
      await left.evaluate((el) =>
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
          }),
        ),
      );
    }
  });
});
