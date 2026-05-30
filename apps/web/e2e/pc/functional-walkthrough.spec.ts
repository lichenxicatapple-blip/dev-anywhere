import { test, expect, type Page } from "@playwright/test";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";

async function terminateSessionFromList(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${page.url().split("#")[0]}#/sessions`);
  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  await expect(row).toBeVisible();
  await row.locator('[data-slot="session-row-menu-trigger"]').click();
  await page.locator('[data-slot="session-row-terminate-item"]').click();
  await page.locator('[data-slot="session-termination-confirm"]').click();
  await expect(row).toHaveCount(0);
}

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
      page.locator('[data-slot="history-group-header"]:visible').filter({ hasText: "sample-app" }),
    ).toHaveCount(0);
    await providerHeaders.filter({ hasText: "Claude" }).click();
    await page
      .locator('[data-slot="history-group-header"]:visible')
      .filter({ hasText: "sample-app" })
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

    await page
      .getByLabel("交互方式")
      .getByRole("button", { name: /聊天模式/ })
      .click();
    await expect(
      page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }),
    ).not.toHaveAttribute("aria-disabled");
    await expect(page.getByText("权限模式")).toBeVisible();
    await page
      .getByLabel("交互方式")
      .getByRole("button", { name: /终端模式/ })
      .click();
    await page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }).click();
    await page.getByLabel("工作目录").fill("/home/dev/projects/sample-app");
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

    const terminalInput = page.locator(
      '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
    );
    await terminalInput.focus();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");
    await page.keyboard.type("hello");
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page))
            .filter((msg) => msg.type === "remote_input_raw")
            .map((msg) => String(msg.data ?? ""))
            .join(""),
      )
      .toContain("hello");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(
      page.locator('[data-slot="chat-overflow-menu"]').getByText("快捷键"),
    ).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-permission-mode"]')).toHaveCount(0);
    // 头部菜单只留 Ctrl+O (其余热键挪到移动端控制条)。这里覆盖 dropdown → raw input 这条路径。
    await page.getByRole("menuitem", { name: "发送 Ctrl+O" }).click();
    await expect(page.locator('[data-slot="chat-overflow-menu"]')).toHaveCount(0);
    const rawInput = (await sentFakeRelayMessages(page))
      .filter((msg) => msg.type === "remote_input_raw")
      .map((msg) => String(msg.data ?? ""))
      .join("");
    expect(rawInput).toContain("hello");
    expect(rawInput).toContain("\n");
    expect(rawInput).toContain("\r");
    expect(rawInput).toContain("\x0f");

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
    // 触屏设备 (pointer:coarse / hover:none) 上 InputBar 把 plain Enter 让给软键盘换行,
    // 必须走"发送"按钮——见 input-bar.tsx 的 submitOnPlainEnter = isDesktop && !touchEditingSurface。
    // 桌面无触控时直接按 Enter 提交。
    const submitsOnEnter = await page.evaluate(
      () =>
        window.matchMedia("(min-width: 768px)").matches &&
        !window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );
    if (submitsOnEnter) {
      await page.keyboard.press("Enter");
    } else {
      await page.getByRole("button", { name: "发送" }).click();
    }
    await expect(page.getByText("run a smoke check")).toBeVisible();
    await expect(page.getByText("收到。")).toBeVisible();

    await terminateSessionFromList(page, "json-sess");
    await expect(page).toHaveURL(/\/sessions/);
    await page.goto(`${page.url().split("#")[0]}#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-bar-region"]')).toHaveCount(0);
  });

  test("terminated PTY sessions expose no terminal input surface", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${page.url().split("#")[0]}#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await terminateSessionFromList(page, "claude-pty");
    await expect(page).toHaveURL(/\/sessions/);

    await page.goto(`${page.url().split("#")[0]}#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveCount(0);
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toHaveCount(0);
  });

  test("creating a session can create a child directory before launch", async ({ page }) => {
    await selectFakeProxy(page);
    await page.locator('button:has-text("新建会话"):visible').last().click();
    await page.getByLabel("工作目录").fill("/home/dev");
    await page.locator('[data-slot="file-path-picker"] button:has-text("新建目录")').click();
    await page.getByPlaceholder("目录名称").fill("new-project-e2e");
    await page.getByRole("button", { name: "创建目录" }).click();
    await expect(page.getByLabel("工作目录")).toHaveValue("/home/dev/new-project-e2e/");

    await page
      .getByRole("dialog", { name: "新建会话" })
      .getByRole("button", { name: "创建" })
      .click();

    await expect(page).toHaveURL(/\/chat\/created-claude-pty-1\?mode=pty/);
    const messages = await sentFakeRelayMessages(page);
    expect(messages.some((msg) => msg.type === "dir_create_request")).toBe(true);
    expect(messages.filter((msg) => msg.type === "session_create")).toHaveLength(1);
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
