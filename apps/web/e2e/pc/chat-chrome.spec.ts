import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay } from "../helpers";

async function installWakeLockMock(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      delayRequest: false,
      requests: 0,
      releases: 0,
      resolveRequest: null as (() => void) | null,
      sentinel: null as
        | (EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          })
        | null,
    };
    Object.defineProperty(window, "__devAnywhereWakeLockTest", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        async request(type: "screen") {
          if (type !== "screen") throw new Error(`unexpected wake lock type: ${type}`);
          state.requests += 1;
          if (state.delayRequest) {
            await new Promise<void>((resolve) => {
              state.resolveRequest = resolve;
            });
          }
          const sentinel = new EventTarget() as EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          };
          sentinel.released = false;
          sentinel.release = async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            state.releases += 1;
            sentinel.dispatchEvent(new Event("release"));
          };
          state.sentinel = sentinel;
          return sentinel;
        },
      },
    });
  });
}

async function wakeLockTestCount(
  page: import("@playwright/test").Page,
  key: "requests" | "releases",
): Promise<number> {
  return page.evaluate(
    (stateKey) =>
      (
        window as Window & {
          __devAnywhereWakeLockTest?: Record<"requests" | "releases", number>;
        }
      ).__devAnywhereWakeLockTest?.[stateKey] ?? 0,
    key,
  );
}

test.describe("ChatHeader compact navigation controls", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/d51-sess?mode=json");
  });

  test("mobile header aligns side actions to the JSON user bubble rail", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("输入聊天消息").fill("标题栏边距测量");
    await page.locator('[data-slot="send-button"][data-variant="send"]').click();

    const back = page.locator('[data-slot="chat-back-button"]');
    const overflow = page.locator('[data-slot="chat-overflow-trigger"]');
    const userBubble = page
      .locator('[data-slot="message-bubble"][data-role="user"]', {
        hasText: "标题栏边距测量",
      })
      .locator('[data-slot="message-row"] > div');
    await expect(back).toBeVisible();
    await expect(overflow).toBeVisible();
    await expect(userBubble).toBeVisible();

    const [backBox, overflowBox, userBubbleBox, viewportWidth] = await Promise.all([
      back.boundingBox(),
      overflow.boundingBox(),
      userBubble.boundingBox(),
      page.evaluate(() => window.innerWidth),
    ]);

    expect(backBox).not.toBeNull();
    expect(overflowBox).not.toBeNull();
    expect(userBubbleBox).not.toBeNull();
    if (!backBox || !overflowBox || !userBubbleBox) return;

    const bubbleRightGap = viewportWidth - (userBubbleBox.x + userBubbleBox.width);
    const overflowRightGap = viewportWidth - (overflowBox.x + overflowBox.width);
    expect(Math.abs(overflowRightGap - bubbleRightGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(backBox.x - bubbleRightGap)).toBeLessThanOrEqual(1);
  });

  test("font controls are aligned without overlap", async ({ page }) => {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();

    const row = page.locator('[data-slot="chat-menu-font-row"]');
    const stepper = page.locator('[data-slot="chat-menu-font-stepper"]');
    const smaller = page.locator('[data-slot="chat-menu-font-smaller"]');
    const value = page.locator('[data-slot="chat-menu-font-size"]');
    const larger = page.locator('[data-slot="chat-menu-font-larger"]');
    const reset = page.locator('[data-slot="chat-menu-font-reset"]');
    const resetLabel = page.locator('[data-slot="chat-menu-font-reset-label"]');

    await expect(stepper).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-font-label"]')).toHaveCount(0);

    const [rowBox, stepperBox, smallerBox, valueBox, largerBox, resetBox, resetLabelBox] =
      await Promise.all([
        row.boundingBox(),
        stepper.boundingBox(),
        smaller.boundingBox(),
        value.boundingBox(),
        larger.boundingBox(),
        reset.boundingBox(),
        resetLabel.boundingBox(),
      ]);

    expect(rowBox).not.toBeNull();
    expect(stepperBox).not.toBeNull();
    expect(smallerBox).not.toBeNull();
    expect(valueBox).not.toBeNull();
    expect(largerBox).not.toBeNull();
    expect(resetBox).not.toBeNull();
    expect(resetLabelBox).not.toBeNull();

    if (
      !rowBox ||
      !stepperBox ||
      !smallerBox ||
      !valueBox ||
      !largerBox ||
      !resetBox ||
      !resetLabelBox
    ) {
      return;
    }

    expect(Math.abs(smallerBox.width - largerBox.width)).toBeLessThanOrEqual(1);
    expect(valueBox.x - (smallerBox.x + smallerBox.width)).toBeGreaterThanOrEqual(0);
    expect(largerBox.x - (valueBox.x + valueBox.width)).toBeGreaterThanOrEqual(0);
    expect(
      Math.abs(valueBox.y + valueBox.height / 2 - (stepperBox.y + stepperBox.height / 2)),
    ).toBeLessThanOrEqual(1);
    expect(stepperBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(Math.abs(stepperBox.x - resetLabelBox.x)).toBeLessThanOrEqual(1);
    expect(stepperBox.x + stepperBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(resetBox.y).toBeGreaterThan(rowBox.y + rowBox.height - 1);
  });

  test("PTY overflow menu exposes terminal shortcuts", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText("快捷键")).toBeVisible();
    await expect(menu.getByText("切换权限模式")).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-permission-mode"]')).toHaveCount(0);
    // Tab / ⇧Tab / ^T / ^C / ^B 已挪到移动端控制条 (PtyMobileControls), header dropdown 这里
    // 仅留低频的 Ctrl+O。PC 桌面物理键盘可以直接发这些组合键, 不再依赖菜单按钮。
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-o"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-t"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-c"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-send-shift-tab"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-b"]')).toHaveCount(0);
    await expect(menu.getByText("会话")).toBeVisible();
    await expect(menu.getByText("显示")).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-screen-wake-lock-item"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-font-control"]')).toBeVisible();

    const wakePaddingLeft = await page
      .locator('[data-slot="chat-menu-screen-wake-lock-item"]')
      .evaluate((node) => getComputedStyle(node).paddingLeft);
    const shortcutPaddingLeft = await page
      .locator('[data-slot="chat-menu-send-ctrl-o"]')
      .evaluate((node) => getComputedStyle(node).paddingLeft);
    expect(wakePaddingLeft).toBe(shortcutPaddingLeft);
  });
});

test.describe("ChatHeader screen wake lock", () => {
  test("screen wake lock follows the chat page lifecycle", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installWakeLockMock(page);
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    const item = page.locator('[data-slot="chat-menu-screen-wake-lock-item"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-state", "unchecked");

    await item.click();
    await expect.poll(() => wakeLockTestCount(page, "requests")).toBe(1);
    await expect(menu).toBeHidden();

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(menu).toBeVisible();
    await expect(item).toHaveAttribute("data-state", "checked");

    await page.locator('[data-slot="chat-back-button"]').click();
    await expect(page).toHaveURL(/\/sessions/);
    await expect.poll(() => wakeLockTestCount(page, "releases")).toBe(1);
  });

  test("screen wake lock is released when switching sessions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installWakeLockMock(page);
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-menu-screen-wake-lock-item"]').click();
    await expect.poll(() => wakeLockTestCount(page, "requests")).toBe(1);

    await page
      .locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible')
      .locator("button")
      .first()
      .click();

    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await expect.poll(() => wakeLockTestCount(page, "releases")).toBe(1);
  });

  test("pending screen wake lock request is released after leaving chat", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installWakeLockMock(page);
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await page.evaluate(() => {
      const state = (
        window as Window & {
          __devAnywhereWakeLockTest?: {
            delayRequest: boolean;
          };
        }
      ).__devAnywhereWakeLockTest;
      if (state) state.delayRequest = true;
    });

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-menu-screen-wake-lock-item"]').click();
    await expect.poll(() => wakeLockTestCount(page, "requests")).toBe(1);

    await page.goto(`${BASE_URL}/#/sessions`);
    await page.evaluate(() => {
      (
        window as Window & {
          __devAnywhereWakeLockTest?: {
            resolveRequest: (() => void) | null;
          };
        }
      ).__devAnywhereWakeLockTest?.resolveRequest?.();
    });

    await expect.poll(() => wakeLockTestCount(page, "releases")).toBe(1);
  });

  test("screen wake lock is released when the chat page goes to background", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installWakeLockMock(page);
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-menu-screen-wake-lock-item"]').click();
    await expect.poll(() => wakeLockTestCount(page, "requests")).toBe(1);

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

    await expect.poll(() => wakeLockTestCount(page, "releases")).toBe(1);
  });
});

test.describe("AppShell Settings slot", () => {
  test("desktop sidebar bottom actions align with the JSON input bar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/sessions");

    async function expectMatchingActionHeights() {
      const create = page.locator('[data-slot="create-session-trigger"]:visible');
      const settings = page.locator('[data-slot="sidebar-settings-trigger"]:visible');
      await expect(create).toBeVisible();
      await expect(settings).toBeVisible();

      const [createBox, settingsBox] = await Promise.all([
        create.boundingBox(),
        settings.boundingBox(),
      ]);
      expect(createBox).not.toBeNull();
      expect(settingsBox).not.toBeNull();
      expect(createBox?.height).toBeGreaterThanOrEqual(44);
      expect(settingsBox?.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs((createBox?.height ?? 0) - (settingsBox?.height ?? 0))).toBeLessThanOrEqual(
        0.5,
      );
    }

    await expectMatchingActionHeights();

    await gotoWithFakeProxy(page, "/#/chat/d51-sess?mode=json");
    const input = page.locator('[data-slot="input-card"]');
    const create = page.locator('[data-slot="create-session-trigger"]:visible');
    const settings = page.locator('[data-slot="sidebar-settings-trigger"]:visible');
    await expect(input).toBeVisible();
    await expect(create).toBeVisible();
    await expect(settings).toBeVisible();

    const [inputBox, createBox, settingsBox] = await Promise.all([
      input.boundingBox(),
      create.boundingBox(),
      settings.boundingBox(),
    ]);
    expect(inputBox).not.toBeNull();
    expect(createBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    for (const actionBox of [createBox, settingsBox]) {
      expect(Math.abs((actionBox?.height ?? 0) - (inputBox?.height ?? 0))).toBeLessThanOrEqual(0.5);
      expect(Math.abs((actionBox?.y ?? 0) - (inputBox?.y ?? 0))).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(
          (actionBox?.y ?? 0) +
            (actionBox?.height ?? 0) -
            ((inputBox?.y ?? 0) + (inputBox?.height ?? 0)),
        ),
      ).toBeLessThanOrEqual(0.5);
    }

    await page.locator('[data-slot="sidebar-collapse-trigger"]').click();
    await expect(page.locator('[data-slot="sidebar-rail"]')).toBeVisible();
    await expectMatchingActionHeights();
  });
});
