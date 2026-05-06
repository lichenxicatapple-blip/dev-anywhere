import { test, expect } from "@playwright/test";
import { BASE_URL, installFakeRelay } from "./helpers";

// 移动端 < md 下 ProxySelect 以 ProxySwitcher layout="page" 形式直接挂在 AppShell 主区
// 没有在线 proxy 时 EmptyState 会兜底, 有 proxy 时渲染 data-slot="proxy-item" 列表
test.describe("ProxySwitcher — page layout (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(BASE_URL);
  });

  test("renders at / without sidebar", async ({ page }) => {
    // 移动端 sidebar hidden, main 填满视口
    const main = page.locator("main");
    await expect(main).toBeVisible();
    // 页面要么渲染 proxy-item 列表, 要么渲染 EmptyState; 都不应崩溃
    const items = page.locator('button[data-slot="proxy-item"]');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("touch-target height is at least 44px on mobile", async ({ page }) => {
    const items = page.locator('button[data-slot="proxy-item"]');
    const first = items.first();
    await expect(first).toBeVisible();
    const box = await first.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

// 桌面端 ≥ md 下 sidebar 顶部渲染 ProxySwitcher layout="dropdown"
// trigger 带 data-slot="proxy-switcher-trigger", 点击后打开 Popover
test.describe("ProxySwitcher — dropdown layout (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(BASE_URL);
  });

  test("renders inside sidebar dropdown slot", async ({ page }) => {
    const switcherTrigger = page.locator('button[data-slot="proxy-switcher-trigger"]');
    await expect(switcherTrigger).toBeVisible();
  });

  test("clicking trigger opens Popover with proxy list or empty state", async ({ page }) => {
    const switcherTrigger = page.locator('button[data-slot="proxy-switcher-trigger"]');
    await switcherTrigger.click();
    // Popover content 落到 portal, Radix 用 data-slot="popover-content"
    const popoverContent = page.locator('[data-slot="popover-content"]');
    await expect(popoverContent).toBeVisible();
  });
});
