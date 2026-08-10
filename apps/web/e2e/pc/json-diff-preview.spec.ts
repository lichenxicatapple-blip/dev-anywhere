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

  test("restores historical tool parameters through the same activity disclosure", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_messages",
        sessionId: "test-sess",
        messages: [
          {
            role: "activity",
            text: "使用工具：wait",
            toolId: "history-wait-1",
            toolName: "wait",
            parameters: { ids: ["job-1"], timeout_ms: 10_000 },
            status: "done",
            cursor: "history:wait:1",
          },
        ],
        hasMore: false,
      });
    });

    const activity = page.locator('[data-slot="activity-bubble"]', { hasText: "使用工具：wait" });
    await expect(activity).toBeVisible();
    await activity.getByRole("button", { name: "展开工具详情" }).click();
    await expect(activity.locator('[data-slot="activity-detail-content"]')).toContainText(
      '"timeout_ms": 10000',
    );
  });

  test("renders historical apply_patch content with the shared red-green diff view", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_messages",
        sessionId: "test-sess",
        messages: [
          {
            role: "activity",
            text: "应用补丁：/tmp/app.ts",
            toolId: "history-patch-1",
            toolName: "Patch",
            parameters: {
              content: [
                "*** Begin Patch",
                "*** Update File: /tmp/app.ts",
                "@@",
                " same",
                "-old",
                "+new",
                "*** End Patch",
              ].join("\n"),
            },
            status: "done",
            cursor: "history:patch:1",
          },
        ],
        hasMore: false,
      });
    });

    const activity = page.locator('[data-slot="activity-bubble"]', {
      hasText: "应用补丁：/tmp/app.ts",
    });
    await expect(activity).toBeVisible();
    await activity.getByRole("button", { name: "展开工具详情" }).click();
    await expect(activity.locator('[data-slot="activity-detail"][data-kind="diff"]')).toBeVisible();
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

  test("keeps running and settled activity indicators on the same vertical axis", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const socket = window.__devAnywhereE2E?.socket;
      const base = {
        timestamp: Date.now(),
        source: "proxy",
        version: "1",
        sessionId: "test-sess",
      };
      socket?.emitJson({
        ...base,
        seq: 101,
        type: "assistant_tool_use",
        payload: {
          toolId: "tool-settled-axis",
          toolName: "Bash",
          parameters: { command: "pnpm lint" },
        },
      });
      socket?.emitJson({
        ...base,
        seq: 102,
        type: "tool_result",
        payload: { toolId: "tool-settled-axis", result: "ok", isError: false },
      });
      socket?.emitJson({
        ...base,
        seq: 103,
        type: "assistant_tool_use",
        payload: {
          toolId: "tool-running-axis",
          toolName: "Bash",
          parameters: { command: "pnpm test" },
        },
      });
    });

    const indicators = page.locator('[data-slot="activity-status-indicator"]');
    await expect(indicators).toHaveCount(2);
    const geometry = await indicators.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { centerX: rect.left + rect.width / 2, width: rect.width, height: rect.height };
      }),
    );
    expect(geometry[0].centerX).toBeCloseTo(geometry[1].centerX, 1);
    expect(geometry[0].width).toBe(geometry[1].width);
    expect(geometry[0].height).toBe(geometry[1].height);
  });
});
