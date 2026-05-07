import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "./helpers";

async function dropClientSocket(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    window.__devAnywhereE2E?.socket?.close();
  });
}

test.describe("WebSocket reconnect chaos", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("keeps PTY approval visible across a client WebSocket reconnect", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "pty_state",
        sessionId: "claude-pty",
        payload: { state: "approval_wait", tool: "Write" },
      });
    });
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "waiting_approval",
    );

    await dropClientSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );

    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "waiting_approval",
      { timeout: 5_000 },
    );
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="session-row"][data-session-id="claude-pty"]'),
    ).toContainText("等待审批");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
  });

  test("does not duplicate JSON pending approval cards after reconnect resource replay", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toHaveCount(1);

    await dropClientSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );

    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "waiting_approval",
      { timeout: 5_000 },
    );
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toHaveCount(1);
  });
});
