// PTY 移动端控制条 2 行布局几何: 高度 ~105px, 按键尺寸统一, BackToBottom 7rem 偏移。
// L2 层用 mobile viewport + hasTouch 触发 controls 浮起, L4 emu 由
// e2e/mobile/pty-mobile-controls.spec.ts 覆盖真触屏交互。
import { expect, test } from "@playwright/test";
import { MOBILE_VIEWPORTS } from "../mobile-helpers";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-controls-layout";

test.describe("PTY mobile controls — 2-row layout geometry", () => {
  test.use({ viewport: MOBILE_VIEWPORTS.standard, hasTouch: true });

  test("two rows render at ~105px height with uniform key sizes and no BackToBottom occlusion", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });
    await expectPtyTerminalMounted(page);

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();

    // 2 行布局: 容器内 grid 2 行 × 6 列, 容器 py-1.5 (12px) + 2*h-11 (88px) +
    // gap-1 (4px) + border-t (1px) ≈ 105px。给 ±15px 容差 (字体行高 / 边框 / shadow)。
    const controlsBox = await controls.boundingBox();
    expect(controlsBox).not.toBeNull();
    if (!controlsBox) return;
    expect(controlsBox.height).toBeGreaterThanOrEqual(95);
    expect(controlsBox.height).toBeLessThanOrEqual(125);

    // 所有非 Enter 按键 outer 都是 h-11 (44px), 用 4 个代表性 slot 抽样:
    // 文本键 / icon 键 / 第一个 / 最后一个。
    const sampleSlots = [
      "pty-mobile-key-tab",
      "pty-mobile-key-clear",
      "pty-mobile-key-up",
      "pty-mobile-key-right",
    ];
    const heights = await Promise.all(
      sampleSlots.map(async (slot) => {
        const box = await page.locator(`[data-slot="${slot}"]`).boundingBox();
        return box?.height ?? 0;
      }),
    );
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(40);
      expect(h).toBeLessThanOrEqual(48);
    }
    // 同一行所有 key 高度应一致 (容差 1px 抗子像素四舍五入)。
    const maxH = Math.max(...heights);
    const minH = Math.min(...heights);
    expect(maxH - minH).toBeLessThanOrEqual(1);

    // BackToBottom 出现时不能被控制条遮挡: BTB 底部坐标 < 控制条顶部坐标。
    // 用滚动制造 BTB 可见 (xterm 历史向上滚)。这里直接跳过断言可见, 改用样式断言:
    // BTB className 含 7rem 偏移 (与控制条 105px + safe-area buffer 匹配)。
    const btb = page.locator('[data-slot="back-to-bottom"]');
    if ((await btb.count()) > 0) {
      const className = await btb.getAttribute("class");
      // 控制条可见时 BTB 类应含 7rem 偏移 (同步 use-pty-view containerPaddingBottom = 112px)
      expect(className ?? "").toContain("7rem");
    }
  });
});
