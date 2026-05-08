import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay } from "./helpers";

test.describe("AppShell header visibility by route", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
  });

  test("AppShell header is mobile-only on /sessions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/#/sessions`);
    const header = page.locator('[data-slot="app-shell-header"]');
    await expect(header).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(header).toBeHidden();
  });

  test("AppShell header HIDDEN on /chat/*", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
    const header = page.locator('[data-slot="app-shell-header"]');
    await expect(header).toHaveCount(0);
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

  test("overflow menu only exposes implemented session actions", async ({ page }) => {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Permission mode")).toHaveCount(0);
    await expect(menu.getByText("重命名")).toHaveCount(0);
    await expect(menu.getByText("复制会话")).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-terminate-item"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-menu-permission-mode"]')).toBeVisible();
  });
});

test.describe("AppShell Settings slot", () => {
  test("Settings gear is available on mobile header and desktop sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/#/sessions`);
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).toBeVisible();
    await expect(page.locator('[data-slot="sidebar-settings-trigger"]')).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).toBeHidden();
    await expect(page.locator('[data-slot="sidebar-settings-trigger"]')).toBeVisible();
  });
});
