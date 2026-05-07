import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "./helpers";

async function dropClientSocket(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    window.__devAnywhereE2E?.socket?.close();
  });
}

async function holdNextConnectionAndDropSocket(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    window.__devAnywhereE2E?.holdConnections();
    window.__devAnywhereE2E?.socket?.close();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const socket = window.__devAnywhereE2E?.socket as
          | { readyState?: number }
          | null
          | undefined;
        return socket?.readyState ?? -1;
      }),
    )
    .not.toBe(1);
}

async function releaseHeldConnections(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    window.__devAnywhereE2E?.releaseConnections();
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

  test("hides PTY input while disconnected and restores it after reconnect", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toBeVisible();

    await holdNextConnectionAndDropSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toHaveCount(0);

    await releaseHeldConnections(page);

    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute("data-state", "idle", {
      timeout: 5_000,
    });
    const sent = await sentFakeRelayMessages(page);
    const lastRegisterIndex = sent.reduce(
      (lastIndex, msg, index) => (msg.type === "client_register" ? index : lastIndex),
      -1,
    );
    const subscribeIndex = sent.findIndex(
      (msg, index) => index > lastRegisterIndex && msg.type === "session_subscribe",
    );
    expect(lastRegisterIndex).toBeGreaterThanOrEqual(0);
    expect(subscribeIndex).toBeGreaterThan(lastRegisterIndex);
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toBeVisible();
  });

  test("does not queue request-response session creation while disconnected", async ({ page }) => {
    await selectFakeProxy(page);
    await page.getByRole("button", { name: "新建会话" }).first().click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
    await page.getByLabel("工作目录").fill("/Users/admin/test_go");

    await holdNextConnectionAndDropSocket(page);
    await page
      .getByRole("dialog", { name: "新建会话" })
      .getByRole("button", { name: "创建" })
      .click();

    await expect(page.getByRole("button", { name: "创建" })).toBeEnabled();
    await expect(page.getByText("连接已断开")).toBeVisible();
    await releaseHeldConnections(page);
    await page.waitForTimeout(50);

    const sent = await sentFakeRelayMessages(page);
    expect(sent.filter((msg) => msg.type === "session_create")).toHaveLength(0);
    await expect(page).toHaveURL(/#\/?$/);
  });
});
