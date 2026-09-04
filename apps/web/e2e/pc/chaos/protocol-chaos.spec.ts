import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "../../helpers";

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
        payload: { state: "approval_wait", seq: 1, tool: "Write" },
      });
    });
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
  });

  test("fake relay enforces strict current control shapes", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/sessions`);
    const row = page.locator('[data-slot="session-row"][data-session-id="test-sess"]:visible');
    await expect(row).toBeVisible();

    const directoryRejection = await page.evaluate(() => {
      const socket = window.__devAnywhereE2E?.socket as unknown as
        | { send(raw: string): void }
        | undefined;
      try {
        socket?.send(
          JSON.stringify({
            type: "dir_list_request",
            requestId: "strict-directory-request",
            path: "/home/dev",
            includeHidden: false,
            proxyId: "unexpected-proxy",
          }),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(directoryRejection).toContain("invalid dir_list_request fixture input");

    const rejection = await page.evaluate(() => {
      const socket = window.__devAnywhereE2E?.socket as unknown as
        | { send(raw: string): void }
        | undefined;
      try {
        socket?.send(
          JSON.stringify({
            type: "session_terminate",
            sessionId: "test-sess",
            seq: 1,
            timestamp: 1,
            source: "client",
            version: "1.0",
            payload: { sessionId: "test-sess" },
          }),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(rejection).toContain("invalid session_terminate fixture input");
    await expect(row).toBeVisible();

    await page.evaluate(() => {
      const socket = window.__devAnywhereE2E?.socket as unknown as
        | { send(raw: string): void }
        | undefined;
      socket?.send(JSON.stringify({ type: "session_terminate", sessionId: "test-sess" }));
    });
    await expect(row).toHaveCount(0);
  });
});
