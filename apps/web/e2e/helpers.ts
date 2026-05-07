import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// 本地 Vite 默认端口 5173；CI 或外部 relay-served 部署可通过 WEB_BASE_URL 覆盖
export const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

// 清理 localStorage cc_* 命名空间并刷新页面，恢复到首次访问状态
export async function resetLocalState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("cc_"));
    keys.forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
}

export type FakeRelayMessage = Record<string, unknown>;

declare global {
  interface Window {
    __devAnywhereE2E?: {
      sent: string[];
      socket: {
        emitJson(payload: FakeRelayMessage): void;
        emitPty(sessionId: string, data: string): void;
      } | null;
    };
  }
}

// 安装一个协议级 Fake Relay。它不是 mock 组件树，而是在浏览器 WebSocket 层模拟
// relay/proxy 的真实控制消息，让测试像用户一样点 UI，同时避免依赖本机真实 CLI。
export async function installFakeRelay(page: Page): Promise<void> {
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
      ...["json-sess", "test-sess", "hist-sess", "f-sess", "fo-sess", "d51-sess"].map(
        (sessionId, index) => ({
          sessionId,
          name: sessionId,
          state: "idle" as const,
          mode: "json" as const,
          provider: "claude" as const,
          lastActive: now - (index + 3) * 60_000,
        }),
      ),
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

    const outputSeqBySession = new Map<string, number>();

    function nextOutputSeq(sessionId: string): number {
      const next = (outputSeqBySession.get(sessionId) ?? 0) + 1;
      outputSeqBySession.set(sessionId, next);
      return next;
    }

    function currentOutputSeq(sessionId: string): number {
      return outputSeqBySession.get(sessionId) ?? 0;
    }

    function encodePtyFrame(sessionId: string, data: string): ArrayBuffer {
      const sid = new TextEncoder().encode(sessionId);
      const payload = new TextEncoder().encode(data);
      const frame = new Uint8Array(1 + sid.length + 4 + payload.length);
      frame[0] = sid.length;
      frame.set(sid, 1);
      new DataView(frame.buffer).setUint32(1 + sid.length, nextOutputSeq(sessionId), true);
      frame.set(payload, 1 + sid.length + 4);
      return frame.buffer;
    }

    class FakeRelayWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly url: string;
      binaryType: BinaryType = "arraybuffer";
      readyState = FakeRelayWebSocket.CONNECTING;

      constructor(url: string) {
        super();
        this.url = url;
        window.__devAnywhereE2E!.socket = this;
        setTimeout(() => {
          this.readyState = FakeRelayWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(raw: string): void {
        window.__devAnywhereE2E!.sent.push(raw);
        let msg: FakeRelayMessage;
        try {
          msg = JSON.parse(raw) as FakeRelayMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case "client_register":
            this.emitJson({ type: "client_register_response", status: "new" });
            break;
          case "proxy_list_request":
            this.emitProxyList();
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
            this.emitResources(String(msg.sessionId ?? ""));
            break;
          case "agent_status_request":
            this.emitJson({
              type: "agent_status",
              sessionId: String(msg.sessionId ?? "json-sess"),
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
              outputSeq: currentOutputSeq(String(msg.sessionId)),
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
            this.emitJson({ type: "session_create_response", sessionId, mode, provider });
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
        this.readyState = FakeRelayWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      emitJson(payload: FakeRelayMessage): void {
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
        }, 0);
      }

      emitPty(sessionId: string, data: string): void {
        this.dispatchEvent(new MessageEvent("message", { data: encodePtyFrame(sessionId, data) }));
      }

      private emitProxyList(): void {
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
      }

      private emitResources(sessionId: string): void {
        this.emitJson({
          type: "command_list_push",
          commands: [
            {
              name: "/init",
              description: "Initialize project memory",
              argumentHint: "[optional context]",
              source: "claude",
            },
            { name: "/compact", description: "Compact context", source: "claude" },
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
        if (sessionId === "json-sess") {
          this.emitJson({
            type: "pending_approvals_push",
            sessionId,
            approvals: [
              {
                requestId: "approval-1",
                toolName: "Bash",
                input: { command: "pnpm test" },
              },
            ],
          });
        }
      }
    }

    localStorage.clear();
    sessionStorage.clear();
    window.__devAnywhereE2E = { sent: [], socket: null };
    window.WebSocket = FakeRelayWebSocket as unknown as typeof WebSocket;
  });
}

export async function selectFakeProxy(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/#/`);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.locator('[data-slot="proxy-switcher-trigger"]').click();
  }
  await page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible').last().click();
  await expect(page.getByRole("button", { name: "新建会话" }).first()).toBeVisible();
}

export async function gotoWithFakeProxy(page: Page, path: string): Promise<void> {
  await selectFakeProxy(page);
  await page.goto(`${BASE_URL}${path}`);
}

export async function sentFakeRelayMessages(page: Page): Promise<FakeRelayMessage[]> {
  return page.evaluate(() =>
    (window.__devAnywhereE2E?.sent ?? []).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as Record<string, unknown>];
      } catch {
        return [];
      }
    }),
  );
}
