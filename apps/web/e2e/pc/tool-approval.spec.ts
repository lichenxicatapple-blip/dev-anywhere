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

  test("sidebar shows waiting approval while an approval card is pending", async ({ page }) => {
    const card = page.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await expect(card).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        seq: Date.now(),
        sessionId: "json-sess",
        timestamp: Date.now(),
        source: "proxy",
        version: "1",
        type: "session_status",
        payload: {
          sessionId: "json-sess",
          state: "working",
          lastActive: Date.now(),
        },
      });
    });

    const row = page.locator('[data-slot="session-row"][data-session-id="json-sess"]');
    await expect(row).toContainText("等待审批");
    await expect(row).not.toContainText("工作中");
  });
});
