import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("Sonner toast — 挂载持久化", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  // Sonner v2 延迟挂载 portal：触发一次 toast 后才会注入 [data-sonner-toaster] 节点。
  // 验证策略：beforeEach 触发一次 toast 以物化 portal；然后断言其始终存在。
  test.beforeEach(async ({ page }) => {
    await page.evaluate(async () => {
      const mod = await import("/src/components/toast.tsx");
      mod.showToast("e2e-mount");
    });
    await expect(
      page.locator("[data-sonner-toaster], section[aria-label^='Notifications']"),
    ).toHaveCount(1);
  });

  test("Toaster 容器挂在 AppShell 根节点", async ({ page }) => {
    const toasterRegion = page.locator(
      "[data-sonner-toaster], section[aria-label^='Notifications']",
    );
    await expect(toasterRegion).toHaveCount(1);
  });

  test("Toaster 容器跨路由切换不 unmount", async ({ page }) => {
    const toasterRegion = page.locator(
      "[data-sonner-toaster], section[aria-label^='Notifications']",
    );
    await expect(toasterRegion).toHaveCount(1);

    await page.goto(`${BASE_URL}/#/sessions`);
    await expect(toasterRegion).toHaveCount(1);

    await page.goto(`${BASE_URL}/#/`);
    await expect(toasterRegion).toHaveCount(1);
  });
});
