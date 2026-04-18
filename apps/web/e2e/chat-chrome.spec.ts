import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("AppShell header — D-51 conditional hide on chat route", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  test("AppShell header visible on /sessions", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/sessions`);
    const header = page.locator('[data-slot="app-shell-header"]');
    await expect(header).toBeVisible();
  });

  test("AppShell header HIDDEN on /chat/*", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
    const header = page.locator('[data-slot="app-shell-header"]');
    await expect(header).toHaveCount(0);
  });
});

test.describe("ChatHeader — D-51 三件套", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
  });

  test("has three direct children: back button + title + overflow", async ({
    page,
  }) => {
    const header = page.locator('[data-slot="chat-header"]');
    await expect(header).toBeVisible();
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-session-title"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="chat-overflow-trigger"]'),
    ).toBeVisible();
  });

  test("back button is visible at ALL viewports (no md:hidden)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
  });

  test("no standalone permission-mode button or sidebar-toggle", async ({
    page,
  }) => {
    const permissionBtn = page.locator(
      '[data-slot="chat-header"] button:has-text("默认"), [data-slot="chat-header"] button:has-text("自动允许"), [data-slot="chat-header"] button:has-text("规划模式")',
    );
    await expect(permissionBtn).toHaveCount(0);
    const sidebarToggle = page.locator(
      '[data-slot="chat-header"] [aria-label*="侧栏"]',
    );
    await expect(sidebarToggle).toHaveCount(0);
  });

  test("overflow menu contains Rename + Duplicate + Terminate(destructive)", async ({
    page,
  }) => {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Permission mode")).toHaveCount(0);
    await expect(menu.getByText("Rename")).toBeVisible();
    await expect(menu.getByText("Duplicate")).toBeVisible();
    const terminate = page.locator('[data-slot="chat-terminate-item"]');
    await expect(terminate).toBeVisible();
    await expect(terminate).toHaveClass(/text-destructive/);
  });
});

test.describe("AppShell Settings slot — D-53", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("AppShell header has Settings gear on non-chat routes", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/sessions`);
    const settings = page.locator('[data-slot="app-shell-settings-trigger"]');
    await expect(settings).toBeVisible();
  });
});
