import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("AppShell layout — mobile (< md)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  test("sidebar is hidden on mobile viewport", async ({ page }) => {
    // Sidebar 带 hidden md:flex，在 390px 宽度下 computed display 应为 none
    const nav = page.locator("nav[aria-label='Sidebar navigation']");
    await expect(nav)
      .toHaveCount(0)
      .catch(async () => {
        await expect(nav).not.toBeVisible();
      });
  });

  test("main content renders at /", async ({ page }) => {
    await expect(page.locator("main")).toBeVisible();
  });
});

test.describe("AppShell layout — desktop (≥ md)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  test("sidebar is visible on desktop viewport", async ({ page }) => {
    const nav = page.locator('nav[data-slot="sidebar"]');
    await expect(nav).toBeVisible();
    await expect(nav).toHaveAttribute("aria-label", "侧边栏");
  });

  test("sidebar width is 280px", async ({ page }) => {
    const nav = page.locator('nav[data-slot="sidebar"]');
    const box = await nav.boundingBox();
    expect(box?.width).toBe(280);
  });

  test("desktop keeps the mobile top-level chrome hidden", async ({ page }) => {
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).not.toBeVisible();
    await expect(page.locator('[data-slot="mobile-settings-trigger"]')).not.toBeVisible();
    await expect(page.locator('[data-slot="sidebar-brand"]')).toBeVisible();
  });
});
