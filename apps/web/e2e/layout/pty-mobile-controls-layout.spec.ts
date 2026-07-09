// PTY 移动端控制条 2 行布局几何: 高度 ~105px, 按键尺寸统一。
// L2 层用 mobile viewport + hasTouch 触发 controls 浮起, L4 emu 由
// e2e/mobile/pty-mobile-controls.spec.ts 覆盖真触屏交互。
import { expect, test } from "@playwright/test";
import { MOBILE_VIEWPORTS, expectNoHorizontalDocumentOverflow } from "../mobile-helpers";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-controls-layout";

function averageRgbChannel(color: string): number {
  const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (channels.length < 3) return 0;
  const normalized = Math.max(...channels) <= 1 ? channels.map((value) => value * 255) : channels;
  return normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
}

test.describe("PTY mobile controls — 2-row layout geometry", () => {
  test.use({ viewport: MOBILE_VIEWPORTS.standard, hasTouch: true });

  test("two rows render at ~105px height with uniform key sizes", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });
    await expectPtyTerminalMounted(page);

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toHaveCount(0);

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );
    await expect(controls).toBeVisible();
    await expect(page.locator("[data-keyboard-offset]").first()).toHaveAttribute(
      "data-keyboard-offset",
      /[1-9]\d*/,
    );
    await expect(page.locator("[data-keyboard-layout-inset]").first()).toHaveAttribute(
      "data-keyboard-layout-inset",
      /[1-9]\d*/,
    );

    await expect
      .poll(async () => {
        const box = await controls.boundingBox();
        const visualViewportHeight = await page.evaluate(
          () => window.visualViewport?.height ?? window.innerHeight,
        );
        if (!box) return false;
        const bottom = box.y + box.height;
        return bottom <= visualViewportHeight + 1 && visualViewportHeight - bottom <= 24;
      })
      .toBe(true);

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
      "pty-mobile-key-esc",
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

    const visualViewportHeight = await page.evaluate(
      () => window.visualViewport?.height ?? window.innerHeight,
    );
    expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(visualViewportHeight + 1);
    expect(visualViewportHeight - (controlsBox.y + controlsBox.height)).toBeLessThanOrEqual(24);
  });

  test("uses light theme tokens instead of hard-coded dark controls", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_theme", "light");
    });
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-light-theme`,
      withVisualViewportMock: true,
    });
    await expectPtyTerminalMounted(page);

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();

    const colors = await page.evaluate(() => {
      const controlRoot = document.querySelector<HTMLElement>('[data-slot="pty-mobile-controls"]');
      const defaultKey = document.querySelector<HTMLElement>(
        '[data-slot="pty-mobile-key-tab"] .dev-pty-mobile-key-pill',
      );
      const pasteKey = document.querySelector<HTMLElement>(
        '[data-slot="pty-mobile-key-paste"] .dev-pty-mobile-key-pill',
      );
      const enterKey = document.querySelector<HTMLElement>(
        '[data-slot="pty-mobile-key-enter"] .dev-pty-mobile-key-pill',
      );
      return {
        controlRoot: controlRoot ? getComputedStyle(controlRoot).backgroundColor : "",
        defaultKey: defaultKey ? getComputedStyle(defaultKey).backgroundColor : "",
        pasteKey: pasteKey ? getComputedStyle(pasteKey).backgroundColor : "",
        enterKey: enterKey ? getComputedStyle(enterKey).backgroundColor : "",
      };
    });

    expect(averageRgbChannel(colors.controlRoot)).toBeGreaterThan(220);
    expect(averageRgbChannel(colors.defaultKey)).toBeGreaterThan(220);
    expect(averageRgbChannel(colors.pasteKey)).toBeGreaterThan(210);
    expect(averageRgbChannel(colors.enterKey)).toBeGreaterThan(210);
  });

  test("forced hardware input preference suppresses mobile controls and keyboard layout inset", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-desktop-interaction`,
      withVisualViewportMock: true,
    });
    await page.evaluate(() => {
      localStorage.setItem("dev_anywhere_inputModePreference", "hardware");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectPtyTerminalMounted(page);

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    await expect(page.locator('[data-slot="pty-mobile-controls"]')).toHaveCount(0);
    await expect(page.locator("[data-keyboard-offset]").first()).toHaveAttribute(
      "data-keyboard-offset",
      "0",
    );
    await expect(page.locator("[data-keyboard-layout-inset]").first()).toHaveAttribute(
      "data-keyboard-layout-inset",
      "0",
    );
  });
});

test.describe("PTY mobile controls — tablet sidebar geometry", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test("spans the visual viewport instead of only the PTY content column", async ({ page }) => {
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-tablet-sidebar`,
      withVisualViewportMock: true,
    });
    await expectPtyTerminalMounted(page);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();
    await expect
      .poll(async () => {
        const box = await controls.boundingBox();
        return box ? Math.round(box.width) : 0;
      })
      .toBe(1024);

    const metrics = await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>('[data-slot="pty-mobile-controls"]');
      const ptyView = document.querySelector<HTMLElement>('[data-slot="chat-pty-view"]');
      const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
      const controlsRect = controls?.getBoundingClientRect();
      const ptyRect = ptyView?.getBoundingClientRect();
      const sidebarRect = sidebar?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        controls: controlsRect
          ? {
              left: controlsRect.left,
              right: controlsRect.right,
              width: controlsRect.width,
            }
          : null,
        ptyView: ptyRect
          ? {
              left: ptyRect.left,
              right: ptyRect.right,
              width: ptyRect.width,
            }
          : null,
        sidebar: sidebarRect
          ? {
              left: sidebarRect.left,
              right: sidebarRect.right,
              width: sidebarRect.width,
            }
          : null,
      };
    });
    expect(metrics.sidebar?.width ?? 0).toBeGreaterThan(0);
    expect(metrics.ptyView?.left ?? 0).toBeGreaterThan(0);
    expect(metrics.controls?.left ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(metrics.controls?.right ?? 0).toBeGreaterThanOrEqual(metrics.viewportWidth - 1);
    expect(metrics.controls?.width ?? 0).toBeGreaterThan(metrics.ptyView?.width ?? 0);
    await expectNoHorizontalDocumentOverflow(page);
  });
});
