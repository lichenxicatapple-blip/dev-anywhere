import { test, expect, type Page } from "@playwright/test";
import { BASE_URL } from "./helpers";

type WalkthroughMessage = Record<string, unknown>;

declare global {
  interface Window {
    __devAnywhereWalkthrough: {
      sent: string[];
      socket: {
        emitJson(payload: WalkthroughMessage): void;
        emitPty(sessionId: string, data: string): void;
      } | null;
    };
  }
}

async function installFunctionalRelay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = Date.now();
    let createCount = 0;
    const sessions: Array<{
      sessionId: string;
      name?: string;
      state: "idle" | "working" | "waiting_approval" | "error" | "terminated";
      mode: "pty" | "json";
      provider: "claude" | "codex";
      lastActive: number;
    }> = [
      {
        sessionId: "claude-pty",
        name: "/Users/admin/test_go/",
        state: "idle",
        mode: "pty",
        provider: "claude",
        lastActive: now - 60_000,
      },
      {
        sessionId: "codex-pty",
        name: "/Users/admin/workspace/dev-anywhere/",
        state: "working",
        mode: "pty",
        provider: "codex",
        lastActive: now - 120_000,
      },
      {
        sessionId: "json-sess",
        name: "JSON structured worker",
        state: "idle",
        mode: "json",
        provider: "claude",
        lastActive: now - 180_000,
      },
    ];

    const history = [
      {
        id: "hist-claude-1",
        title: "Claude history",
        projectDir: "/Users/admin/test_go",
        updatedAt: now - 300_000,
        provider: "claude",
      },
      {
        id: "hist-codex-1",
        title: "Codex history",
        projectDir: "/Users/admin/workspace/dev-anywhere",
        updatedAt: now - 600_000,
        provider: "codex",
      },
    ];

    function envelope(type: string, sessionId: string, payload: unknown) {
      return {
        seq: Date.now(),
        sessionId,
        timestamp: Date.now(),
        source: "proxy",
        version: "1",
        type,
        payload,
      };
    }

    function encodePtyFrame(sessionId: string, data: string): ArrayBuffer {
      const sid = new TextEncoder().encode(sessionId);
      const payload = new TextEncoder().encode(data);
      const frame = new Uint8Array(1 + sid.length + payload.length);
      frame[0] = sid.length;
      frame.set(sid, 1);
      frame.set(payload, 1 + sid.length);
      return frame.buffer;
    }

    class FunctionalWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly url: string;
      binaryType: BinaryType = "arraybuffer";
      readyState = FunctionalWebSocket.CONNECTING;

      constructor(url: string) {
        super();
        this.url = url;
        window.__devAnywhereWalkthrough.socket = this;
        setTimeout(() => {
          this.readyState = FunctionalWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(raw: string): void {
        window.__devAnywhereWalkthrough.sent.push(raw);
        let msg: WalkthroughMessage;
        try {
          msg = JSON.parse(raw) as WalkthroughMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case "client_register":
            this.emitJson({ type: "client_register_response", status: "new" });
            break;
          case "proxy_list_request":
            this.emitJson({
              type: "proxy_list_response",
              proxies: [
                {
                  proxyId: "proxy-1",
                  name: "Local Mac",
                  online: true,
                  sessions: sessions.map((s) => s.sessionId),
                },
              ],
            });
            break;
          case "proxy_select":
            this.emitJson({ type: "proxy_select_response", success: true, proxyId: "proxy-1" });
            break;
          case "session_list":
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          case "session_history_request":
            this.emitJson({ type: "session_history_response", sessions: history });
            break;
          case "proxy_info_request":
            this.emitJson({ type: "proxy_info", homePath: "/Users/admin" });
            break;
          case "dir_list_request":
            this.emitJson({
              type: "dir_list_response",
              path: String(msg.path),
              entries:
                msg.path === "/Users/admin"
                  ? [
                      { name: "test_go", isDir: true },
                      { name: "workspace", isDir: true },
                      { name: "notes.md", isDir: false },
                    ]
                  : [
                      { name: "src", isDir: true },
                      { name: "README.md", isDir: false },
                    ],
            });
            break;
          case "session_resources_request":
            this.emitJson({
              type: "command_list_push",
              commands: [
                {
                  name: "/init",
                  description: "Initialize project memory",
                  argumentHint: "[optional context]",
                  source: "claude",
                },
                {
                  name: "/compact",
                  description: "Compact context",
                  source: "claude",
                },
              ],
            });
            this.emitJson({
              type: "file_tree_push",
              groups: [
                {
                  path: "/Users/admin/test_go",
                  entries: [
                    { name: "src", isDir: true },
                    { name: "README.md", isDir: false },
                  ],
                },
              ],
            });
            if (msg.sessionId === "json-sess") {
              this.emitJson({
                type: "pending_approvals_push",
                sessionId: "json-sess",
                approvals: [
                  {
                    requestId: "approval-1",
                    toolName: "Bash",
                    input: { command: "pnpm test" },
                  },
                ],
              });
            }
            break;
          case "agent_status_request":
            this.emitJson({
              type: "agent_status",
              sessionId: String(msg.sessionId ?? "claude-pty"),
              payload: {
                provider: "claude",
                phase: "idle",
                seq: 1,
                updatedAt: Date.now(),
              },
            });
            break;
          case "session_subscribe":
            this.emitJson({
              type: "session_snapshot",
              sessionId: String(msg.sessionId),
              requestId: String(msg.requestId ?? ""),
              cols: 80,
              rows: 24,
              data: "Dev Anywhere PTY ready\r\n$ ",
            });
            this.emitJson({
              type: "terminal_title",
              sessionId: String(msg.sessionId),
              title: "Claude Code",
            });
            break;
          case "session_create": {
            const provider = msg.provider === "codex" ? "codex" : "claude";
            const mode = msg.mode === "json" ? "json" : "pty";
            const sessionId = `created-${provider}-${mode}-${++createCount}`;
            sessions.unshift({
              sessionId,
              name: String(msg.cwd),
              state: "idle",
              mode,
              provider,
              lastActive: Date.now(),
            });
            this.emitJson({
              type: "session_create_response",
              sessionId,
              mode,
              provider,
            });
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          }
          case "session_terminate":
            sessions.splice(
              0,
              sessions.length,
              ...sessions.filter((s) => s.sessionId !== msg.sessionId),
            );
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          case "tool_approve":
          case "tool_deny":
            this.emitJson({
              type: "permission_decision_result",
              sessionId: String(msg.sessionId),
              requestId: String((msg.payload as { toolId?: string } | undefined)?.toolId),
              outcome: msg.type === "tool_approve" ? "allow" : "deny",
              delivered: true,
            });
            break;
          case "user_input":
            this.emitJson(
              envelope("session_status", String(msg.sessionId), {
                sessionId: String(msg.sessionId),
                state: "working",
                lastActive: Date.now(),
              }),
            );
            this.emitJson(
              envelope("assistant_message", String(msg.sessionId), {
                text: "收到。",
                isPartial: false,
              }),
            );
            break;
          default:
            break;
        }
      }

      close(): void {
        this.readyState = FunctionalWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      emitJson(payload: WalkthroughMessage): void {
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
        }, 0);
      }

      emitPty(sessionId: string, data: string): void {
        this.dispatchEvent(new MessageEvent("message", { data: encodePtyFrame(sessionId, data) }));
      }
    }

    localStorage.clear();
    sessionStorage.clear();
    window.__devAnywhereWalkthrough = { sent: [], socket: null };
    window.WebSocket = FunctionalWebSocket as unknown as typeof WebSocket;
  });
}

async function selectProxy(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/#/`);
  const viewport = page.viewportSize();
  if ((viewport?.width ?? 0) >= 768) {
    await page.locator('[data-slot="proxy-switcher-trigger"]').click();
  }
  await page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible').last().click();
  await expect(page.getByRole("button", { name: "新建会话" }).first()).toBeVisible();
}

async function sentMessages(page: Page): Promise<WalkthroughMessage[]> {
  return page.evaluate(() =>
    window.__devAnywhereWalkthrough.sent.flatMap((raw) => {
      try {
        return [JSON.parse(raw) as Record<string, unknown>];
      } catch {
        return [];
      }
    }),
  );
}

test.describe("functional browser walkthrough", () => {
  test.beforeEach(async ({ page }) => {
    await installFunctionalRelay(page);
  });

  test("covers proxy selection, grouped sessions, history, creation, PTY raw input, JSON, approval, and termination", async ({
    page,
  }) => {
    await selectProxy(page);

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
          (await sentMessages(page)).filter((msg) => msg.type === "session_create").length,
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
    const rawInput = (await sentMessages(page))
      .filter((msg) => msg.type === "remote_input_raw")
      .map((msg) => String(msg.data ?? ""))
      .join("");
    expect(rawInput).toContain("hello");
    expect(rawInput).toContain("\n");
    expect(rawInput).toContain("\r");
    expect(rawInput).toContain("\x03");

    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toBeVisible();
    await page.locator('[data-slot="tool-approval-card"] [data-action="deny"]').click();
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await sentMessages(page)).filter((msg) => msg.type === "tool_deny").length)
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
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible();
  });
});
