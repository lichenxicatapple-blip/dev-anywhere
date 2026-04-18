import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("ChatJsonView — follow-output", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
    await resetLocalState(page);
  });

  test("BackToBottom absent on empty state", async ({ page }) => {
    // 空消息列表默认渲染 EmptyState no-messages, BackToBottom 不应出现
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveCount(0);
  });

  test("input-bar-slot placeholder present (10-04b will replace)", async ({
    page,
  }) => {
    const slot = page.locator('[data-slot="input-bar-slot"]');
    await expect(slot).toBeVisible();
  });
});
