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

  test("hides the previous proxy sessions throughout a slow switch", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/sessions");
    const oldSession = page.locator(
      '[data-slot="session-row"][data-session-id="claude-pty"]:visible',
    );
    await expect(oldSession).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "proxy_list_response",
        proxies: [
          { proxyId: "proxy-1", name: "Local Mac", online: true, sessions: ["claude-pty"] },
          { proxyId: "proxy-slow", name: "Slow Mac", online: true, sessions: [] },
        ],
      });
      window.__devAnywhereE2E?.setProxySelectDelay(600);
      window.__devAnywhereE2E?.setSessionListDelay(600);
    });

    await page.locator('button[data-slot="proxy-switcher-trigger"]').click();
    const target = page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-slow"]:visible');
    await target.click();

    await expect(target).toHaveAttribute("aria-busy", "true");
    const sidebarLoading = page.locator(
      '[data-slot="sidebar-session-list"] [data-slot="session-list-loading"]',
    );
    await expect(sidebarLoading).toContainText("正在连接 Slow Mac...");
    await expect(oldSession).toHaveCount(0);

    await expect(sidebarLoading).toBeVisible({ timeout: 2_000 });
    await expect(sidebarLoading).toContainText("正在连接 Slow Mac...");
    await expect(oldSession).toHaveCount(0);

    await expect(oldSession).toBeVisible({ timeout: 3_000 });
    await expect(sidebarLoading).toHaveCount(0);
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

  test("does not show the previous session list after a slow mobile proxy switch", async ({
    page,
  }) => {
    await gotoWithFakeProxy(page, "/#/sessions");
    const oldSession = page.locator(
      '[data-slot="session-row"][data-session-id="claude-pty"]:visible',
    );
    await expect(oldSession).toBeVisible();

    await page.locator('[data-slot="mobile-switch-proxy"]').click();
    await expect(page).toHaveURL(/\/#\/$/);
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "proxy_list_response",
        proxies: [
          { proxyId: "proxy-1", name: "Local Mac", online: true, sessions: ["claude-pty"] },
          { proxyId: "proxy-slow", name: "Slow Mac", online: true, sessions: [] },
        ],
      });
      window.__devAnywhereE2E?.setProxySelectDelay(400);
      window.__devAnywhereE2E?.setSessionListDelay(700);
    });

    await page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-slow"]:visible').click();
    await expect(page).toHaveURL(/\/sessions$/, { timeout: 2_000 });

    const pageLoading = page.locator('main [data-slot="session-list-loading"]');
    await expect(pageLoading).toBeVisible();
    await expect(pageLoading).toContainText("正在连接 Slow Mac...");
    await expect(oldSession).toHaveCount(0);

    await expect(oldSession).toBeVisible({ timeout: 3_000 });
    await expect(pageLoading).toHaveCount(0);
  });
});
