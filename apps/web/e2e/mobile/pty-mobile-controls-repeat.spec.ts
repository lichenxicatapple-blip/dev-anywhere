// PTY 移动端软控制按键长按 repeat: 持续按住方向键应连续发送 raw 序列
// (实现节奏: 首发立即, 300ms hold 后, 之后 50ms 一次稳定 repeat).
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";

const SESSION_ID = "mobile-pty-repeat";

test.describe("L4 mobile / PTY soft controls long-press repeat", () => {
  test.setTimeout(60_000);

  test("holding the left arrow button emits multiple ESC[D sequences", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await emuPage.locator('[data-slot="pty-terminal"]').click();
    const left = emuPage.locator('[data-slot="pty-mobile-key-left"]');
    await expect(left).toBeVisible();

    // 直接派 PointerEvent (emu Chrome 上 Playwright mouse.down/up 不一定能触发 React
    // onPointerDown 的 hold 流程, dispatchEvent 显式派事件最可靠).
    await left.evaluate((el) =>
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );
    // hold 600ms 让 hold 阈值过 + repeat 多次 (300ms 阈值 + 50ms 间隔 = ~6 次).
    await emuPage.waitForTimeout(600);
    await left.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));

    // raw input 应包含至少 3 次 \x1b[D (1 首发 + hold 后多次 repeat).
    const occurrences = (await readRawPtyInput(emuPage)).match(/\x1b\[D/g)?.length ?? 0;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});
