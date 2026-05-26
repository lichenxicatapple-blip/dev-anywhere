import { expect, test } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

test.describe("JSON diff preview", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
  });

  test("renders Edit activity details as unified diff rows", async ({ page }) => {
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        seq: Date.now(),
        sessionId: "test-sess",
        timestamp: Date.now(),
        source: "proxy",
        version: "1",
        type: "assistant_tool_use",
        payload: {
          toolId: "tool-edit-1",
          toolName: "Edit",
          parameters: {
            file_path: "/tmp/result.txt",
            old_string: "same\nold",
            new_string: "same\nnew",
          },
        },
      });
    });

    const activity = page.locator('[data-slot="activity-bubble"]', { hasText: "编辑文件" });
    await expect(activity).toBeVisible();
    await activity.getByRole("button", { name: "展开工具详情" }).click();

    await expect(activity.locator('[data-slot="activity-diff-content"]')).toBeVisible();
    await expect(activity.locator('[data-slot="activity-detail-content"]')).toHaveCount(0);
    await expect(
      activity.locator('[data-slot="activity-diff-row"][data-kind="remove"]'),
    ).toHaveCount(1);
    await expect(activity.locator('[data-slot="activity-diff-row"][data-kind="add"]')).toHaveCount(
      1,
    );
  });

  test("renders Edit approval details as a diff preview", async ({ page }) => {
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "pending_approvals_push",
        sessionId: "test-sess",
        approvals: [
          {
            requestId: "approval-edit-1",
            toolName: "Edit",
            input: {
              file_path: "/tmp/result.txt",
              old_string: "same\nold",
              new_string: "same\nnew",
            },
          },
        ],
      });
    });

    const card = page.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "展开详情" }).click();

    await expect(card.locator('[data-slot="tool-approval-preview"]')).toBeVisible();
    await expect(card.locator('[data-slot="tool-approval-json"]')).toHaveCount(0);
    await expect(card.locator('[data-slot="activity-diff-row"][data-kind="remove"]')).toHaveCount(
      1,
    );
    await expect(card.locator('[data-slot="activity-diff-row"][data-kind="add"]')).toHaveCount(1);
  });
});
