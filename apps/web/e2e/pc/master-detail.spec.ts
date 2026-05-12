import { test, expect } from "@playwright/test";
import { BASE_URL, gotoWithFakeProxy, installFakeRelay, selectFakeProxy } from "../helpers";

test.describe("Master-detail — 桌面端即时会话切换", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("侧栏挂载 session-list slot", async ({ page }) => {
    await page.goto(BASE_URL);
    const sidebar = page.locator("nav[aria-label='侧边栏']");
    await expect(sidebar).toBeVisible();
    // 即便 session 列表为空，slot 容器也必须存在，避免桌面布局跳变。
    const middle = sidebar.locator('[data-slot="sidebar-session-list"]');
    await expect(middle).toHaveCount(1);
  });

  test("点击 session row 更新 URL 而不 reload 文档", async ({ page }) => {
    await selectFakeProxy(page);
    const row = page.locator('[data-slot="session-row"][data-session-id="test-sess"]:visible');
    await row.click();
    await expect(page).toHaveURL(/\/chat\/test-sess/);
    // performance navigation type 校验：同文档切换不是 reload
    const navType = await page.evaluate(() => {
      const entries = performance.getEntriesByType("navigation");
      return entries.length > 0 ? (entries[0] as PerformanceNavigationTiming).type : "unknown";
    });
    expect(navType).not.toBe("reload");
  });

  test("选中 session row 带 data-selected='true'", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
    const selectedRow = page.locator(
      '[data-slot="session-row"][data-session-id="test-sess"][data-selected="true"]:visible',
    );
    await expect(selectedRow).toBeVisible();
  });
});
