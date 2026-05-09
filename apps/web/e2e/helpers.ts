import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// 本地 Vite 默认端口 5173；CI 或外部 relay-served 部署可通过 WEB_BASE_URL 覆盖
export const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

// 清理 DEV Anywhere 写入的 localStorage key 并刷新页面，恢复到首次访问状态
export async function resetLocalState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("dev_anywhere_"));
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
        close(): void;
      } | null;
      holdConnections(): void;
      releaseConnections(): void;
    };
  }
}

// 安装一个协议级 Fake Relay。它不是 mock 组件树，而是在浏览器 WebSocket 层模拟
// relay/proxy 的真实控制消息，让测试像用户一样点 UI，同时避免依赖本机真实 CLI。
export async function installFakeRelay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = Date.now();
    let createCount = 0;
    const sessionStorageKey = "__dev_anywhere_e2e_sessions";
    const directoryStorageKey = "__dev_anywhere_e2e_dirs";
    const initializedKey = "__dev_anywhere_e2e_initialized";
    const initialized = sessionStorage.getItem(initializedKey) === "1";
    if (!initialized) {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem(initializedKey, "1");
    }

    type FakeSession = {
      sessionId: string;
      name?: string;
      state: "idle" | "working" | "waiting_approval" | "error" | "terminated";
      mode: "pty" | "json";
      provider: "claude" | "codex";
      lastActive: number;
    };

    const defaultSessions: FakeSession[] = [
      {
        sessionId: "claude-pty",
        name: "/home/dev/projects/sample-app/",
        state: "idle",
        mode: "pty",
        provider: "claude",
        lastActive: now - 60_000,
      },
      {
        sessionId: "codex-pty",
        name: "/home/dev/projects/dev-anywhere/",
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
    const persistedSessions = localStorage.getItem(sessionStorageKey);
    const sessions: FakeSession[] = persistedSessions
      ? (JSON.parse(persistedSessions) as FakeSession[])
      : defaultSessions;
    const defaultDirectories = [
      "/home/dev",
      "/home/dev/projects/sample-app",
      "/home/dev/projects",
      "/home/dev/projects/dev-anywhere",
    ];
    const persistedDirectories = localStorage.getItem(directoryStorageKey);
    const directories = new Set<string>(
      persistedDirectories ? (JSON.parse(persistedDirectories) as string[]) : defaultDirectories,
    );
    const heldSockets = new Set<FakeRelayWebSocket>();
    let holdConnections = false;
    const ptyBuffers = new Map<string, string>();

    function persistSessions(): void {
      localStorage.setItem(sessionStorageKey, JSON.stringify(sessions));
    }

    function persistDirectories(): void {
      localStorage.setItem(directoryStorageKey, JSON.stringify([...directories]));
    }

    const history = [
      {
        id: "hist-claude-1",
        title: "Claude history",
        projectDir: "/home/dev/projects/sample-app",
        updatedAt: now - 300_000,
        provider: "claude",
      },
      {
        id: "hist-codex-1",
        title: "Codex history",
        projectDir: "/home/dev/projects/dev-anywhere",
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

    type FakeHistoryMessage = {
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      cursor: string;
    };

    function makeHistoryMessage(index: number, label: string): FakeHistoryMessage {
      const role = index % 2 === 0 ? "assistant" : "user";
      return {
        role,
        text:
          index === 27
            ? "移动端历史问题：请检查 JSON 渲染。"
            : index === 28
              ? "移动端历史回复：历史消息已经加载。"
              : `${label} ${String(index).padStart(2, "0")}\n这是一条用于移动端上滑分页冒烟的 JSON 历史消息，内容较长以形成真实滚动高度。`,
        timestamp: now - (30 - index) * 1_000,
        cursor: `hist-${String(index).padStart(2, "0")}`,
      };
    }

    function emitHistoryPage(socket: FakeRelayWebSocket, msg: FakeRelayMessage): void {
      const sessionId = String(msg.sessionId);
      const before = typeof msg.before === "string" ? msg.before : undefined;
      if (sessionId !== "hist-sess") {
        socket.emitJson({
          type: "session_history_messages",
          requestId: msg.requestId,
          sessionId,
          messages: [],
          hasMore: false,
        });
        return;
      }

      if (before === "hist-before-13") {
        socket.emitJson({
          type: "session_history_messages",
          requestId: msg.requestId,
          sessionId,
          before,
          messages: Array.from({ length: 12 }, (_, i) => makeHistoryMessage(i + 1, "更早历史")),
          hasMore: false,
        });
        return;
      }

      socket.emitJson({
        type: "session_history_messages",
        requestId: msg.requestId,
        sessionId,
        messages: Array.from({ length: 16 }, (_, i) => makeHistoryMessage(i + 13, "最近历史")),
        hasMore: true,
        nextBefore: "hist-before-13",
      });
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
          if (this.readyState !== FakeRelayWebSocket.CONNECTING) return;
          if (holdConnections) {
            heldSockets.add(this);
            return;
          }
          this.open();
        }, 0);
      }

      open(): void {
        if (this.readyState !== FakeRelayWebSocket.CONNECTING) return;
        heldSockets.delete(this);
        this.readyState = FakeRelayWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
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
            this.emitProxyList(String(msg.requestId ?? ""));
            break;
          case "proxy_select":
            this.emitJson({
              type: "proxy_select_response",
              requestId: msg.requestId,
              success: true,
              proxyId: "proxy-1",
            });
            break;
          case "session_list":
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          case "session_history_request":
            this.emitJson({
              type: "session_history_response",
              requestId: msg.requestId,
              sessions: history,
            });
            break;
          case "proxy_info_request":
            this.emitJson({
              type: "proxy_info",
              requestId: msg.requestId,
              homePath: "/home/dev",
              agentCli: {
                claude: {
                  available: true,
                  command: "/home/dev/.local/bin/claude",
                },
                codex: {
                  available: true,
                  command: "/home/dev/.local/bin/codex",
                },
              },
            });
            break;
          case "dir_list_request":
            this.emitJson({
              type: "dir_list_response",
              requestId: msg.requestId,
              path: String(msg.path),
              entries:
                msg.path === "/home/dev"
                  ? [
                      { name: "sample-app", isDir: true },
                      { name: "projects", isDir: true },
                      { name: "notes.md", isDir: false },
                    ]
                  : [
                      { name: "src", isDir: true },
                      { name: "README.md", isDir: false },
                    ],
            });
            break;
          case "dir_create_request": {
            const path = String(msg.path ?? "");
            directories.add(path);
            persistDirectories();
            this.emitJson({
              type: "dir_create_response",
              requestId: msg.requestId,
              path,
              success: true,
            });
            break;
          }
          case "clipboard_image_upload":
            this.emitJson({
              type: "clipboard_image_upload_response",
              requestId: msg.requestId,
              sessionId: String(msg.sessionId),
              success: true,
              path: `.dev-anywhere/clipboard/${String(msg.sessionId)}/pasted-e2e.png`,
            });
            break;
          case "session_resources_request":
            this.emitResources(String(msg.sessionId ?? ""), String(msg.requestId ?? ""));
            break;
          case "agent_status_request":
            this.emitJson({
              type: "agent_status_response",
              requestId: msg.requestId,
              statuses: [
                {
                  sessionId: String(msg.sessionId ?? "json-sess"),
                  payload: {
                    provider: "claude",
                    phase: "idle",
                    seq: 1,
                    updatedAt: Date.now(),
                  },
                },
              ],
            });
            break;
          case "session_messages_request":
            emitHistoryPage(this, msg);
            break;
          case "session_subscribe":
            this.emitJson({
              type: "session_snapshot",
              sessionId: String(msg.sessionId),
              requestId: String(msg.requestId ?? ""),
              cols: 80,
              rows: 24,
              data: ptyBuffers.get(String(msg.sessionId)) ?? "Dev Anywhere PTY ready\r\n$ ",
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
            const cwd = String(msg.cwd ?? "");
            const cwdKey = cwd.replace(/\/+$/, "") || "/";
            if (!directories.has(cwdKey)) {
              this.emitJson({
                type: "session_create_response",
                requestId: msg.requestId,
                errorCode: "PATH_NOT_FOUND",
                error: `工作目录不存在或不可访问: ${cwd}`,
              });
              break;
            }
            const sessionId = `created-${provider}-${mode}-${++createCount}`;
            sessions.unshift({
              sessionId,
              name: cwd,
              state: "idle",
              mode,
              provider,
              lastActive: Date.now(),
            });
            persistSessions();
            this.emitJson({
              type: "session_create_response",
              requestId: msg.requestId,
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
            persistSessions();
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
              envelope("user_input", String(msg.sessionId), {
                text: String((msg.payload as { text?: string } | undefined)?.text ?? ""),
                messageId:
                  (msg.payload as { messageId?: string } | undefined)?.messageId ??
                  `${String(msg.sessionId)}-user-${Date.now()}`,
              }),
            );
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
        const statusEchoes: FakeRelayMessage[] = [];
        if (payload.type === "pty_state") {
          const session = sessions.find((s) => s.sessionId === payload.sessionId);
          const ptyPayload = payload.payload as { state?: string } | undefined;
          if (session && ptyPayload?.state === "approval_wait") {
            session.state = "waiting_approval";
            session.lastActive = Date.now();
          }
          if (session && (ptyPayload?.state === "working" || ptyPayload?.state === "mid_pause")) {
            session.state = "working";
            session.lastActive = Date.now();
          }
          if (session && ptyPayload?.state === "turn_complete") {
            session.state = "idle";
            session.lastActive = Date.now();
          }
          if (session) {
            statusEchoes.push(
              envelope("session_status", session.sessionId, {
                sessionId: session.sessionId,
                state: session.state,
                lastActive: session.lastActive,
              }),
            );
            persistSessions();
          }
        }
        if (payload.type === "session_status" && typeof payload.payload === "object") {
          const status = payload.payload as {
            sessionId?: string;
            state?: string;
            lastActive?: number;
          };
          const session = sessions.find((s) => s.sessionId === status.sessionId);
          if (session && typeof status.state === "string") {
            session.state = status.state as typeof session.state;
            session.lastActive = status.lastActive ?? Date.now();
            persistSessions();
          }
        }
        setTimeout(() => {
          for (const statusEcho of statusEchoes) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(statusEcho) }));
          }
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
        }, 0);
      }

      emitPty(sessionId: string, data: string): void {
        ptyBuffers.set(sessionId, `${ptyBuffers.get(sessionId) ?? ""}${data}`);
        this.dispatchEvent(new MessageEvent("message", { data: encodePtyFrame(sessionId, data) }));
      }

      private emitProxyList(requestId?: string): void {
        this.emitJson({
          type: "proxy_list_response",
          requestId,
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

      private emitResources(sessionId: string, requestId?: string): void {
        this.emitJson({
          type: "session_resources_response",
          requestId,
          sessionId,
          commands: [
            {
              name: "/init",
              description: "Initialize project memory",
              argumentHint: "[optional context]",
              source: "claude",
            },
            { name: "/compact", description: "Compact context", source: "claude" },
          ],
          groups: [
            {
              path: "/home/dev/projects/sample-app",
              entries: [
                { name: "src", isDir: true },
                { name: "README.md", isDir: false },
              ],
            },
          ],
        });
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
              path: "/home/dev/projects/sample-app",
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

    window.__devAnywhereE2E = {
      sent: [],
      socket: null,
      holdConnections() {
        holdConnections = true;
      },
      releaseConnections() {
        holdConnections = false;
        for (const socket of [...heldSockets]) {
          socket.open();
        }
      },
    };
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
