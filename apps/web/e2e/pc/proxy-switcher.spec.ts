import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

// 桌面端 ≥ md 下 sidebar 顶部渲染 ProxySwitcher layout="dropdown"
// trigger 带 data-slot="proxy-switcher-trigger", 点击后打开 Popover
test.describe("ProxySwitcher — dropdown layout (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("switching proxy from a chat route returns to the session list", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    await expect(page).toHaveURL(/\/chat\/json-sess/);

    await page.locator('button[data-slot="proxy-switcher-trigger"]').click();
    await page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible').click();

    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toHaveCount(0);
  });
});
