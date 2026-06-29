import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay } from "../helpers";

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

test.describe("ProxySwitcher — page layout (mobile viewport)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("shows immediate feedback while selecting a proxy on slow connections", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/`);
    await page.evaluate(() => window.__devAnywhereE2E?.setProxySelectDelay(800));

    const proxyItem = page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]').first();
    await expect(proxyItem).toBeVisible();

    await proxyItem.click();

    await expect(proxyItem).toHaveAttribute("data-selecting", "true");
    await expect(proxyItem).toHaveAttribute("aria-busy", "true");
    await expect(proxyItem).toContainText("正在连接");
    await expect(page).not.toHaveURL(/\/sessions$/);

    await expect(page).toHaveURL(/\/sessions$/, { timeout: 5_000 });
  });
});
