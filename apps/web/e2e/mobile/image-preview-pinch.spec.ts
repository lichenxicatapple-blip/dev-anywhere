// 真 Android emu 上 image preview 的两指 pinch zoom: PC chromium-emulation 模拟
// 双指能跑过, 但真 touch driver 路径不一定一致 (合成 vs native), 这条 L4 case 守住。
// dblclick reset / wheel zoom / drag pan 已经在 e2e/pc/image-preview.spec.ts 覆盖,
// 这里只钉 pinch 一个交互, 不重复测库的 reset 行为。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";
import type { Page } from "@playwright/test";

const PATH = ".dev-anywhere/clipboard/test-sess/pinch.png";

const IDENTITY_TRANSFORM = /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/;

async function openPreview(page: Page): Promise<void> {
  const input = page.getByLabel("输入聊天消息");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(`inspect @${PATH}`);
  // Android CDP reports layout-viewport coordinates while the IME animates the visual
  // viewport, so Playwright's mouse-style click can target the input actions wrapper.
  // Message submission is only fixture setup here; the pinch itself remains native touch.
  await page
    .locator('[data-slot="send-button"][data-variant="send"]')
    .evaluate((button: HTMLButtonElement) => button.click());
  await page
    .locator('[data-slot="inline-image-preview-link"]', { hasText: PATH })
    .evaluate((link: HTMLElement) => link.click());

  await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
  await expect(page.locator('[data-slot="image-preview-stage"]')).toBeVisible();
  await expect(page.locator('[data-slot="image-preview-img"]')).toHaveAttribute(
    "data-loaded",
    "true",
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-slot="image-preview-loading"]')).toBeHidden();
}

async function dispatchBoundedPinch(page: Page): Promise<void> {
  const stage = page.locator('[data-slot="image-preview-stage"]');
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();

  const margin = 28;
  const cx = stageBox!.x + stageBox!.width / 2;
  const cy = stageBox!.y + stageBox!.height / 2;
  const maxOffset = Math.floor(
    Math.max(36, Math.min(150, stageBox!.width / 2 - margin, stageBox!.height / 2 - margin)),
  );
  expect(maxOffset).toBeGreaterThan(28);

  // Keep both fingers inside the preview stage. The previous ±200px gesture can
  // leave a 360/390px mobile viewport after dialog padding, and Android Chrome's
  // native touch path may drop that first-run gesture instead of delivering a
  // deterministic pinch sequence.
  const offsets = [24, 36, 52, 72, 96, 122, maxOffset].filter(
    (offset, index, values) => offset <= maxOffset && values.indexOf(offset) === index,
  );
  const touchPoints = (offset: number) => [
    { x: cx - offset, y: cy, id: 1, radiusX: 4, radiusY: 4, force: 1 },
    { x: cx + offset, y: cy, id: 2, radiusX: 4, radiusY: 4, force: 1 },
  ];

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touchPoints(offsets[0] ?? 24),
    });
    for (const offset of offsets.slice(1)) {
      await page.waitForTimeout(45);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: touchPoints(offset),
      });
    }
    await page.waitForTimeout(45);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

test.describe("L4 mobile / image preview pinch zoom", () => {
  test.setTimeout(60_000);

  test("two-finger pinch zooms transform out of identity", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    await openPreview(emuPage);
    await dispatchBoundedPinch(emuPage);

    const transform = emuPage.locator(
      '[data-slot="image-preview-stage"] .react-transform-component',
    );
    await expect
      .poll(() => transform.evaluate((el) => getComputedStyle(el).transform), {
        message: "pinch should zoom the image preview out of identity transform",
        timeout: 10_000,
      })
      .not.toMatch(IDENTITY_TRANSFORM);
  });
});
