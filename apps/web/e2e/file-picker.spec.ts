import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("FilePathPicker @ trigger (InputBar mode=insert)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/f-sess?mode=json`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/chat/f-sess?mode=json`);
  });

  test("typing @ opens FilePathPicker in insert mode", async ({ page }) => {
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await input.fill("@");
    const picker = page.locator(
      '[data-slot="file-path-picker"][data-mode="insert"]',
    );
    await expect(picker).toBeVisible();
  });
});

test.describe("FilePathPicker in CreateSessionDialog (mode=select, dirsOnly)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/sessions`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/sessions`);
  });

  test("CreateSessionDialog renders FilePathPicker (select mode)", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /新建会话/ }).first().click();
    const picker = page.locator(
      '[data-slot="file-path-picker"][data-mode="select"]',
    );
    await expect(picker).toBeVisible();
  });
});
