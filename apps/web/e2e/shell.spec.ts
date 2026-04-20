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
    const nav = page.locator("nav[aria-label='Sidebar navigation']");
    await expect(nav).toBeVisible();
  });

  test("sidebar width is 280px", async ({ page }) => {
    const nav = page.locator("nav[aria-label='Sidebar navigation']");
    const box = await nav.boundingBox();
    expect(box?.width).toBe(280);
  });

  test("header is 48px high", async ({ page }) => {
    const header = page.locator("header[role='banner']");
    const box = await header.boundingBox();
    expect(box?.height).toBe(48);
  });
});
