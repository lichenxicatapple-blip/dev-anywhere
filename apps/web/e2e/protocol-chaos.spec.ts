import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "./helpers";

test.describe("protocol chaos", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("ignores stale requestId snapshots after the matching resources response has applied", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/test-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_resources_response",
        requestId: "stale-resources",
        sessionId: "test-sess",
        commands: [{ name: "/stale", description: "stale", source: "chaos" }],
        groups: [{ path: "/stale", entries: [{ name: "stale_dir", isDir: true }] }],
      });
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_messages",
        requestId: "stale-history",
        sessionId: "test-sess",
        messages: [{ role: "assistant", text: "STALE HISTORY SHOULD NOT RENDER" }],
      });
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "agent_status_response",
        requestId: "stale-agent-status",
        statuses: [
          {
            sessionId: "test-sess",
            payload: {
              provider: "claude",
              phase: "waiting_permission",
              seq: 999,
              updatedAt: Date.now(),
            },
          },
        ],
      });
    });

    await page.getByLabel("输入聊天消息").fill("@");
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="insert"]')).toBeVisible();
    await expect(page.getByText("src")).toBeVisible();
    await expect(page.getByText("stale_dir")).toHaveCount(0);
    await expect(page.getByText("STALE HISTORY SHOULD NOT RENDER")).toHaveCount(0);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute("data-state", "idle");
  });

  test("keeps PTY approval recovery driven by active snapshots, not stale responses", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "agent_status_response",
        requestId: "stale-agent-status",
        statuses: [
          {
            sessionId: "claude-pty",
            payload: {
              provider: "claude",
              phase: "waiting_permission",
              seq: 999,
              updatedAt: Date.now(),
            },
          },
        ],
      });
    });
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "pty_state",
        sessionId: "claude-pty",
        payload: { state: "approval_wait", tool: "Write" },
      });
    });
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
  });
});
