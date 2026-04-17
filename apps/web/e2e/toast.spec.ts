import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("Sonner toast — 挂载持久化", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  test("Toaster 容器挂在 AppShell 根节点", async ({ page }) => {
    // Sonner 挂载后会在 DOM 里注入 [data-sonner-toaster] 区域，验证 AppShell 正确引入
    const toasterRegion = page.locator("[data-sonner-toaster], [aria-label='Notifications']");
    await expect(toasterRegion).toHaveCount(1);
  });

  test("Toaster 容器跨路由切换不 unmount", async ({ page }) => {
    const toasterRegion = page.locator("[data-sonner-toaster], [aria-label='Notifications']");
    await expect(toasterRegion).toHaveCount(1);

    await page.goto(`${BASE_URL}/#/sessions`);
    await expect(toasterRegion).toHaveCount(1);

    await page.goto(`${BASE_URL}/#/`);
    await expect(toasterRegion).toHaveCount(1);
  });
});
