import { test, expect } from "@playwright/test";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "./helpers";

test.describe("functional browser walkthrough", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("covers proxy selection, grouped sessions, history, creation, PTY raw input, JSON, approval, and termination", async ({
    page,
  }) => {
    await selectFakeProxy(page);

    await expect(
      page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible'),
    ).toBeVisible();

    await page.locator('[data-slot="history-section-header"]:visible').click();
    const providerHeaders = page.locator('[data-slot="history-provider-header"]:visible');
    await expect(providerHeaders.filter({ hasText: "Claude" })).toBeVisible();
    await expect(providerHeaders.filter({ hasText: "Codex" })).toBeVisible();
    await providerHeaders.filter({ hasText: "Claude" }).click();
    await expect(
      page.locator('[data-slot="history-group-header"]:visible').filter({ hasText: "test_go" }),
    ).toHaveCount(0);
    await providerHeaders.filter({ hasText: "Claude" }).click();
    await page
      .locator('[data-slot="history-group-header"]:visible')
      .filter({ hasText: "test_go" })
      .click();
    await expect(
      page.locator('[data-slot="history-row"][data-session-id="hist-claude-1"]:visible'),
    ).toBeVisible();

    await page.locator('button:has-text("新建会话"):visible').last().click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
    await page.getByLabel("工作目录").focus();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toBeVisible();
    await page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }).click();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toHaveCount(0);

    await page.getByLabel("交互模式").getByRole("button", { name: /JSON/ }).click();
    await expect(
      page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("权限模式")).toBeVisible();
    await page.getByLabel("交互模式").getByRole("button", { name: /^PTY/ }).click();
    await page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }).click();
    await page.getByLabel("工作目录").fill("/Users/admin/test_go");
    await page
      .getByRole("dialog", { name: "新建会话" })
      .getByRole("button", { name: "创建" })
      .click();
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter((msg) => msg.type === "session_create").length,
      )
      .toBeGreaterThanOrEqual(1);

    await expect(page).toHaveURL(/\/chat\/created-codex-pty-1\?mode=pty/);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-bar-region"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="chat-session-title"]')).toHaveText("Claude Code");
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("hello");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.getByRole("menuitem", { name: "发送 Ctrl+C" }).click();
    const rawInput = (await sentFakeRelayMessages(page))
      .filter((msg) => msg.type === "remote_input_raw")
      .map((msg) => String(msg.data ?? ""))
      .join("");
    expect(rawInput).toContain("hello");
    expect(rawInput).toContain("\n");
    expect(rawInput).toContain("\r");
    expect(rawInput).toContain("\x03");

    await page.goto(`${page.url().split("#")[0]}#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toBeVisible();
    await page.locator('[data-slot="tool-approval-card"] [data-action="deny"]').click();
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter((msg) => msg.type === "tool_deny").length,
      )
      .toBeGreaterThanOrEqual(1);

    const textbox = page.getByLabel("输入聊天消息");
    await textbox.fill("/");
    await expect(page.locator('[data-slot="slash-command-picker"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await textbox.fill("@");
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="insert"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await textbox.fill("run a smoke check");
    await page.keyboard.press("Enter");
    await expect(page.getByText("run a smoke check")).toBeVisible();
    await expect(page.getByText("收到。")).toBeVisible();

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-terminate-item"]').click();
    await expect(page).toHaveURL(/\/sessions/);
    await page.goto(`${page.url().split("#")[0]}#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-bar-region"]')).toHaveCount(0);
  });

  test("terminated PTY sessions expose no terminal input surface", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${page.url().split("#")[0]}#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-terminate-item"]').click();
    await expect(page).toHaveURL(/\/sessions/);

    await page.goto(`${page.url().split("#")[0]}#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveCount(0);
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toHaveCount(0);
  });

  test("PTY approval state is visible immediately and survives refresh", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${page.url().split("#")[0]}#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "pty_state",
        sessionId: "claude-pty",
        payload: { state: "approval_wait", tool: "Write" },
      });
    });

    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="session-row"][data-session-id="claude-pty"]'),
    ).toContainText("等待审批");

    await page.reload();
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="session-row"][data-session-id="claude-pty"]'),
    ).toContainText("等待审批");
  });
});
