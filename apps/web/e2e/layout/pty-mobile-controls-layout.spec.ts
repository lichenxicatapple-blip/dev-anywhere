// PTY 移动端控制条布局几何: 竖屏 2 行、横屏 1 行，按键尺寸统一。
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

test.describe("PTY mobile controls — portrait layout geometry", () => {
  test.use({ viewport: MOBILE_VIEWPORTS.standard, hasTouch: true });

  test("two rows keep uniform key sizes and keyboard-edge clearance", async ({ page }) => {
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

    // 2 行布局: 容器内 grid 2 行 × 6 列。辅助区底部留出键盘边缘安全区，
    // 避免输入法的顶部工具栏盖住最下排按键。
    const controlsBox = await controls.boundingBox();
    expect(controlsBox).not.toBeNull();
    if (!controlsBox) return;
    expect(controlsBox.height).toBeGreaterThanOrEqual(95);
    expect(controlsBox.height).toBeLessThanOrEqual(125);

    const interactiveBottomClearance = await controls.evaluate((element) => {
      const rootRect = element.getBoundingClientRect();
      const keys = Array.from(
        element.querySelectorAll<HTMLElement>('button[data-slot^="pty-mobile-key-"]'),
      );
      return rootRect.bottom - Math.max(...keys.map((key) => key.getBoundingClientRect().bottom));
    });
    expect(interactiveBottomClearance).toBeGreaterThanOrEqual(15);

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

    const arrowGeometry = await page.evaluate(() => {
      const rect = (slot: string) =>
        document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.getBoundingClientRect();
      const up = rect("pty-mobile-key-up");
      const left = rect("pty-mobile-key-left");
      const down = rect("pty-mobile-key-down");
      const right = rect("pty-mobile-key-right");
      return {
        up: up ? { x: up.x, y: up.y, width: up.width } : null,
        left: left ? { x: left.x, y: left.y, width: left.width } : null,
        down: down ? { x: down.x, y: down.y, width: down.width } : null,
        right: right ? { x: right.x, y: right.y, width: right.width } : null,
      };
    });
    expect(arrowGeometry.up).not.toBeNull();
    expect(arrowGeometry.left).not.toBeNull();
    expect(arrowGeometry.down).not.toBeNull();
    expect(arrowGeometry.right).not.toBeNull();
    expect(arrowGeometry.up!.y).toBeLessThan(arrowGeometry.down!.y);
    expect(arrowGeometry.left!.y).toBe(arrowGeometry.down!.y);
    expect(arrowGeometry.right!.y).toBe(arrowGeometry.down!.y);
    expect(arrowGeometry.up!.x).toBe(arrowGeometry.down!.x);
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

test.describe("PTY mobile controls — iPad landscape keyboard", () => {
  test.use({
    viewport: MOBILE_VIEWPORTS.landscape,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
  });

  test("uses one control row and persists explicit floating-keyboard hint opt-out", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        get: () => "MacIntel",
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        get: () => 5,
      });
      localStorage.removeItem("dev_anywhere_ipadFloatingKeyboardHintDismissed");
    });
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-ipad-landscape`,
      withVisualViewportMock: true,
    });
    await expectPtyTerminalMounted(page);

    await page.locator('[data-slot="pty-terminal"]').click();
    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();
    const geometry = await page.evaluate(() => {
      const controlRoot = document.querySelector<HTMLElement>('[data-slot="pty-mobile-controls"]');
      const terminal = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
      const keys = Array.from(
        controlRoot?.querySelectorAll<HTMLElement>("button[data-slot]") ?? [],
      );
      const rootRect = controlRoot?.getBoundingClientRect();
      return {
        controlHeight: rootRect?.height ?? 0,
        bottomPadding:
          rootRect && keys.length > 0
            ? rootRect.bottom - Math.max(...keys.map((key) => key.getBoundingClientRect().bottom))
            : 0,
        keyCount: keys.length,
        keyRows: new Set(keys.map((key) => Math.round(key.getBoundingClientRect().top))).size,
        keyHeights: keys.map((key) => key.getBoundingClientRect().height),
        slotsByPosition: keys
          .map((key) => ({ slot: key.dataset.slot ?? "", x: key.getBoundingClientRect().x }))
          .sort((a, b) => a.x - b.x)
          .map(({ slot }) => slot),
        terminalPaddingBottom: terminal
          ? Number.parseFloat(getComputedStyle(terminal).paddingBottom)
          : 0,
      };
    });
    expect(geometry.keyCount).toBe(14);
    expect(geometry.keyRows).toBe(1);
    expect(geometry.controlHeight).toBeGreaterThanOrEqual(50);
    expect(geometry.controlHeight).toBeLessThanOrEqual(70);
    expect(geometry.bottomPadding).toBeGreaterThanOrEqual(15);
    expect(geometry.bottomPadding).toBeLessThanOrEqual(17);
    expect(geometry.slotsByPosition.slice(8, 12)).toEqual([
      "pty-mobile-key-left",
      "pty-mobile-key-up",
      "pty-mobile-key-down",
      "pty-mobile-key-right",
    ]);
    for (const height of geometry.keyHeights) {
      expect(height).toBeGreaterThanOrEqual(40);
      expect(height).toBeLessThanOrEqual(48);
    }
    expect(
      Math.abs(geometry.terminalPaddingBottom - (geometry.controlHeight + 8)),
    ).toBeLessThanOrEqual(1);

    const hint = page.getByTestId("ipad-floating-keyboard-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("可以缩小软键盘");
    await expect(hint).toContainText("双指向内捏合");
    const dismiss = hint.getByRole("button", { name: "不再显示" });
    await expect(dismiss).toBeVisible();
    const hintLayout = await hint.evaluate((element) => {
      const content = element.querySelector<HTMLElement>("[data-content]");
      const action = element.querySelector<HTMLElement>("[data-action]");
      const contentRect = content?.getBoundingClientRect();
      const actionRect = action?.getBoundingClientRect();
      return {
        contentRight: contentRect?.right ?? 0,
        actionLeft: actionRect?.left ?? 0,
        actionHeight: actionRect?.height ?? 0,
      };
    });
    expect(hintLayout.actionLeft).toBeGreaterThanOrEqual(hintLayout.contentRight);
    expect(hintLayout.actionHeight).toBeGreaterThanOrEqual(44);

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.5),
        offsetTop: 0,
      }),
    );
    await expect(page.getByTestId("ipad-floating-keyboard-hint")).toHaveCount(1);

    await dismiss.click();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("dev_anywhere_ipadFloatingKeyboardHintDismissed")),
      )
      .toBe("1");
    await expect(hint).toHaveCount(0);

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: window.innerHeight,
        offsetTop: 0,
      }),
    );
    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );
    await expect(page.getByTestId("ipad-floating-keyboard-hint")).toHaveCount(0);
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
