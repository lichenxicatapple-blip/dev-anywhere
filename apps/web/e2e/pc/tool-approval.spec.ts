import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

test.describe("ToolApprovalCard — keyboard shortcuts", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
  });

  test("card shows three buttons with exact copy when approval seeded", async ({ page }) => {
    const card = page.locator('[data-slot="tool-approval-card"]').first();
    await expect(card.getByRole("button", { name: "允许", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "始终允许", exact: true })).toBeVisible();
  });
});
