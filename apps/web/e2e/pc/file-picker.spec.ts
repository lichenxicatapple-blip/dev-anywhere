import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, selectFakeProxy } from "../helpers";

test.describe("FilePathPicker @ trigger (InputBar mode=insert)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/f-sess?mode=json");
  });

  test("typing @ opens FilePathPicker in insert mode", async ({ page }) => {
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await input.fill("@");
    const picker = page.locator('[data-slot="file-path-picker"][data-mode="insert"]');
    await expect(picker).toBeVisible();
  });
});

test.describe("FilePathPicker in CreateSessionDialog (mode=select, dirsOnly)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
  });

  test("CreateSessionDialog renders FilePathPicker (select mode)", async ({ page }) => {
    await page.locator('button:has-text("新建会话"):visible').last().click();
    await page.getByLabel("工作目录").focus();
    const picker = page.locator('[data-slot="file-path-picker"][data-mode="select"]');
    await expect(picker).toBeVisible();
  });
});
