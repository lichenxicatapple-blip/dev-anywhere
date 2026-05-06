import { test, expect } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "./helpers";

test.describe("CreateSessionDialog — 字段校验", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
  });

  test("点击「新建会话」打开 Dialog", async ({ page }) => {
    await page.locator('button:has-text("新建会话"):visible').last().click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  });

  test("空 CWD 提交触发错误提示", async ({ page }) => {
    await page.locator('button:has-text("新建会话"):visible').last().click();
    await page.getByLabel("工作目录").fill("");
    // 直接点「创建」提交空表单
    await page.getByRole("button", { name: "创建" }).click();
    // Sonner toast 或 role=status 会出现
    const toast = page.locator("[data-sonner-toast], [role='status']").first();
    await expect(toast).toBeVisible();
  });

  test("点击「取消」关闭 Dialog", async ({ page }) => {
    await page.locator('button:has-text("新建会话"):visible').last().click();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("heading", { name: "新建会话" })).not.toBeVisible();
  });
});

test.describe("SessionList — layout=page（移动端）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/sessions`);
  });

  test("/sessions 路由渲染主区", async ({ page }) => {
    expect(page.url()).toContain("/sessions");
    // 无数据时渲染 EmptyState + 新建会话按钮；有数据时渲染列表
    const main = page.locator("main");
    await expect(main).toBeVisible();
  });
});
