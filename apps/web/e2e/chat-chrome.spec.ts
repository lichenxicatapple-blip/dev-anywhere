import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay } from "./helpers";
import { expectTouchTarget } from "./mobile-helpers";

test.describe("AppShell top-level mobile chrome", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
  });

  test("mobile top-level pages use brand hero plus floating settings", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/#/sessions`);

    await expect(page.locator('[data-slot="app-shell-header"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="mobile-brand-hero"] [data-slot="brand-typewriter"]'),
    ).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="mobile-settings-trigger"]'));

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeHidden();
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).toBeHidden();
    await expect(page.locator('[data-slot="sidebar-brand"]')).toBeVisible();
  });

  test("top-level mobile chrome is hidden on /chat/*", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
    await expect(page.locator('[data-slot="app-shell-header"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).toHaveCount(0);
  });
});

test.describe("ChatHeader compact navigation controls", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/d51-sess?mode=json");
  });

  test("desktop header shows centered title and overflow", async ({ page }) => {
    const header = page.locator('[data-slot="chat-header"]');
    await expect(header).toBeVisible();
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeHidden();
    await expect(page.locator('[data-slot="chat-session-title"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-overflow-trigger"]')).toBeVisible();
  });

  test("back button is mobile-only", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeHidden();
  });

  test("no standalone permission-mode button or sidebar-toggle", async ({ page }) => {
    const permissionBtn = page.locator(
      '[data-slot="chat-header"] button:has-text("默认"), [data-slot="chat-header"] button:has-text("自动允许"), [data-slot="chat-header"] button:has-text("规划模式")',
    );
    await expect(permissionBtn).toHaveCount(0);
    const sidebarToggle = page.locator('[data-slot="chat-header"] [aria-label*="侧栏"]');
    await expect(sidebarToggle).toHaveCount(0);
  });

  test("overflow menu only exposes implemented chat actions", async ({ page }) => {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Permission mode")).toHaveCount(0);
    await expect(menu.getByText("切换权限模式")).toHaveCount(0);
    await expect(menu.getByText("快捷键")).toHaveCount(0);
    await expect(menu.getByText("重命名")).toHaveCount(0);
    await expect(menu.getByText("复制会话")).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-terminate-item"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-font-control"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-t"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-c"]')).toHaveCount(0);
  });

  test("font controls are aligned as a compact stepper", async ({ page }) => {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();

    const stepper = page.locator('[data-slot="chat-menu-font-stepper"]');
    const smaller = page.locator('[data-slot="chat-menu-font-smaller"]');
    const value = page.locator('[data-slot="chat-menu-font-size"]');
    const larger = page.locator('[data-slot="chat-menu-font-larger"]');
    const reset = page.locator('[data-slot="chat-menu-font-reset"]');

    await expect(stepper).toBeVisible();

    const [stepperBox, smallerBox, valueBox, largerBox, resetBox] = await Promise.all([
      stepper.boundingBox(),
      smaller.boundingBox(),
      value.boundingBox(),
      larger.boundingBox(),
      reset.boundingBox(),
    ]);

    expect(stepperBox).not.toBeNull();
    expect(smallerBox).not.toBeNull();
    expect(valueBox).not.toBeNull();
    expect(largerBox).not.toBeNull();
    expect(resetBox).not.toBeNull();

    if (!stepperBox || !smallerBox || !valueBox || !largerBox || !resetBox) {
      return;
    }

    expect(Math.abs(smallerBox.width - largerBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(smallerBox.height - valueBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(largerBox.height - valueBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(valueBox.x - (smallerBox.x + smallerBox.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(largerBox.x - (valueBox.x + valueBox.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(stepperBox.x - (resetBox.x + 8))).toBeLessThanOrEqual(2);
  });

  test("PTY overflow menu exposes terminal shortcuts", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText("快捷键")).toBeVisible();
    await expect(menu.getByText("切换权限模式")).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-permission-mode"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-t"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-send-ctrl-c"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-font-control"]')).toBeVisible();
  });
});

test.describe("AppShell Settings slot", () => {
  test("Settings gear opens the same dialog from mobile floating button and desktop sidebar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/sessions`);
    const mobileSettings = page.locator('[data-slot="mobile-settings-trigger"]');

    await expect(mobileSettings).toBeVisible();
    await expectTouchTarget(mobileSettings);
    await expect(page.locator('[data-slot="sidebar-settings-trigger"]')).toBeHidden();
    await mobileSettings.click();
    await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).toBeHidden();
    const desktopSettings = page.locator('[data-slot="sidebar-settings-trigger"]');
    await expect(desktopSettings).toBeVisible();
    await desktopSettings.click();
    await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();
  });
});
