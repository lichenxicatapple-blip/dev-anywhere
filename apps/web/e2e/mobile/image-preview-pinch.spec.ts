// 真 Android emu 上 image preview 的两指 pinch zoom: PC chromium-emulation 模拟
// 双指能跑过, 但真 touch driver 路径不一定一致 (合成 vs native), 这条 L4 case 守住。
// dblclick reset / wheel zoom / drag pan 已经在 e2e/pc/image-preview.spec.ts 覆盖,
// 这里只钉 pinch 一个交互, 不重复测库的 reset 行为。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";

const PATH = ".dev-anywhere/clipboard/test-sess/pinch.png";

test.describe("L4 mobile / image preview pinch zoom", () => {
  test.setTimeout(60_000);

  test("two-finger pinch zooms transform out of identity", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.fill(`inspect @${PATH}`);
    await emuPage.locator('[data-slot="send-button"][data-variant="send"]').click();
    await emuPage.locator('[data-slot="inline-image-preview-link"]', { hasText: PATH }).click();

    await expect(emuPage.locator('[data-slot="image-preview-img"]')).toHaveAttribute(
      "data-loaded",
      "true",
      { timeout: 15_000 },
    );

    const stage = emuPage.locator('[data-slot="image-preview-stage"]');
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();
    const cx = stageBox!.x + stageBox!.width / 2;
    const cy = stageBox!.y + stageBox!.height / 2;

    // CDP Input.dispatchTouchEvent 在真 Android Chrome 上走 native touch driver;
    // 两指从中心 ±20 滑开到 ±200 (6 步), lib 的 onTouchPanning 在 touches.length===2
    // 时进入 pinch 分支, 算两指距离变化转 scale。
    const cdp = await emuPage.context().newCDPSession(emuPage);
    const points = (offset: number) => [
      { x: cx - offset, y: cy, id: 1 },
      { x: cx + offset, y: cy, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(20) });
    for (const offset of [40, 80, 120, 160, 200]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(offset),
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const transform = emuPage.locator(
      '[data-slot="image-preview-stage"] .react-transform-component',
    );
    await expect
      .poll(() => transform.evaluate((el) => getComputedStyle(el).transform))
      .not.toMatch(/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/);
  });
});
