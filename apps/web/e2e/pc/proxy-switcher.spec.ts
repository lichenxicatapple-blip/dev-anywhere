import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay } from "../helpers";
import { dispatchTouchSwipe } from "../touch-input";

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
          {
            proxyId: "proxy-1",
            name: "Local Mac",
            version: "0.9.0",
            online: true,
            sessions: ["claude-pty"],
          },
          { proxyId: "proxy-slow", name: "Slow Mac", version: "0.9.0", online: true, sessions: [] },
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

  test("removes an offline proxy from its desktop overflow menu", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/`);
    await page.locator('button[data-slot="proxy-switcher-trigger"]').click();
    await expect(
      page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"][data-online="true"]:visible'),
    ).toBeVisible();
    await page.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(false));

    const offlineRow = page.locator(
      '[data-slot="proxy-item"][data-proxy-id="proxy-1"][data-online="false"]:visible',
    );
    await expect(offlineRow).toBeVisible();
    await page.locator('[data-slot="proxy-row-menu-trigger"]:visible').click();
    await page.locator('[data-slot="proxy-row-remove-item"]:visible').click();

    const dialog = page.locator('[data-slot="proxy-removal-dialog"]');
    await expect(dialog).toContainText("以后重新运行时，它会重新出现在列表中");
    await dialog.locator('[data-slot="proxy-removal-confirm"]').click();
    await expect(page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]')).toHaveCount(0);
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

  test("left-swipes to remove only an offline proxy and allows it to reconnect later", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/#/`);
    await expect(
      page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible'),
    ).toBeVisible();
    await page.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(false));

    const row = page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]');
    await expect(row).toHaveAttribute("data-online", "false");
    const foreground = row.locator('[data-slot="proxy-swipe-foreground"]');
    const remove = row.locator('[data-slot="proxy-mobile-remove"]');
    await expect(row).not.toHaveAttribute("data-revealed", "true");
    await expect(remove).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator('[data-slot="proxy-row-menu-trigger"]')).toHaveCount(0);
    const closed = await foreground.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.right - 16, rect.top + rect.height / 2);
      return {
        opacity: getComputedStyle(node).opacity,
        offset: node.getAttribute("data-offset"),
        foregroundRight: rect.right,
        hitForeground: hit?.closest('[data-slot="proxy-swipe-foreground"]') === node,
        start: { x: rect.right - 16, y: rect.top + rect.height / 2 },
        end: { x: rect.right - 96, y: rect.top + rect.height / 2 + 1 },
      };
    });
    expect(closed).toMatchObject({ opacity: "1", offset: "0", hitForeground: true });

    await dispatchTouchSwipe(page, closed.start, closed.end);

    await expect(row).toHaveAttribute("data-revealed", "true");
    await expect(remove).not.toHaveAttribute("aria-hidden");
    const revealed = await row.evaluate((node) => {
      const rowRect = node.getBoundingClientRect();
      const foregroundRect = node
        .querySelector<HTMLElement>('[data-slot="proxy-swipe-foreground"]')!
        .getBoundingClientRect();
      const actionRect = node
        .querySelector<HTMLElement>('[data-slot="proxy-mobile-remove"]')!
        .getBoundingClientRect();
      const hit = document.elementFromPoint(rowRect.right - 40, rowRect.top + rowRect.height / 2);
      return {
        foregroundRight: foregroundRect.right,
        joinGap: actionRect.left - foregroundRect.right,
        topDelta: actionRect.top - foregroundRect.top,
        bottomDelta: actionRect.bottom - foregroundRect.bottom,
        hitRemove: hit?.closest('[data-slot="proxy-mobile-remove"]') !== null,
      };
    });
    expect(closed.foregroundRight - revealed.foregroundRight).toBeCloseTo(80, 0);
    expect(revealed.joinGap).toBeCloseTo(0, 1);
    expect(revealed.topDelta).toBeCloseTo(0, 1);
    expect(revealed.bottomDelta).toBeCloseTo(0, 1);
    expect(revealed.hitRemove).toBe(true);

    await remove.click();
    const dialog = page.locator('[data-slot="proxy-removal-dialog"]');
    await expect(dialog).toContainText("不会阻止它再次连接");
    await dialog.locator('[data-slot="proxy-removal-confirm"]').click();
    await expect(row).toHaveCount(0);

    await page.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(true));
    const reconnected = page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]');
    await expect(reconnected).toHaveAttribute("data-online", "true");
    await reconnected.click();
    await expect(page).toHaveURL(/\/sessions$/);
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
          {
            proxyId: "proxy-1",
            name: "Local Mac",
            version: "0.9.0",
            online: true,
            sessions: ["claude-pty"],
          },
          { proxyId: "proxy-slow", name: "Slow Mac", version: "0.9.0", online: true, sessions: [] },
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
