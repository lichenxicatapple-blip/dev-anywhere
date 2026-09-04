// PTY spec 共用的 fake relay + chat setup helper.
// 每个 spec 用自己的 sessionId, 通过 setupPtyChat 完成 init+reload+resetLocal 流程.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { MESSAGE_ENVELOPE_VERSION, RELAY_CONTROL_PROTOCOL_VERSION } from "@dev-anywhere/shared";
import { BASE_URL, resetLocalState } from "./helpers";
import { installVisualViewportMock } from "./mobile-helpers";

type PtyFakeRelayOptionsBase = {
  sessionId: string;
  snapshotData?: string;
  cols: number;
  rows: number;
};

export type PtyFakeRelayOptions =
  | (PtyFakeRelayOptionsBase & {
      sessionKind: "agent";
      provider: "claude" | "codex" | "kimi";
      ptyOwner: "local-terminal" | "proxy-hosted";
    })
  | (PtyFakeRelayOptionsBase & {
      sessionKind: "terminal";
      provider: "claude";
      ptyOwner: "local-terminal";
    });

const PTY_FAKE_RELAY_ACTIVE_KEY = "__dev_anywhere_pty_fake_relay_active";

export async function installPtyFakeRelay(page: Page, options: PtyFakeRelayOptions): Promise<void> {
  const { sessionKind, provider, ptyOwner } = options;
  const sessionCwd = "/tmp";

  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        auth: { clientTokenRequired: false },
      }),
    });
  });

  await page.route("**/api/auth/client", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page
    .evaluate(
      ({ key, sessionId, provider }) => {
        sessionStorage.setItem(key, JSON.stringify({ sessionId, provider }));
      },
      {
        key: PTY_FAKE_RELAY_ACTIVE_KEY,
        sessionId: options.sessionId,
        provider,
      },
    )
    .catch(() => {});
  await page.addInitScript(
    ({
      activeKey,
      sessionId,
      provider,
      sessionKind,
      ptyOwner,
      snapshotData,
      initialCols,
      initialRows,
      controlProtocolVersion,
      envelopeVersion,
      sessionCwd,
    }) => {
      const active = (() => {
        try {
          return JSON.parse(sessionStorage.getItem(activeKey) ?? "null") as {
            sessionId?: string;
            provider?: "claude" | "codex" | "kimi";
          } | null;
        } catch {
          return null;
        }
      })();
      const href = window.location.href;
      const urlMatches =
        href.includes(`/${encodeURIComponent(sessionId)}`) || href.includes(`/${sessionId}`);
      if (active?.sessionId && active.sessionId !== sessionId) {
        return;
      }
      if (!active?.sessionId && !urlMatches) {
        return;
      }
      const installedKey = `__dev_anywhere_pty_fake_relay_${sessionId}`;
      const alreadyInstalled = (window as unknown as Record<string, unknown>)[installedKey];
      if (alreadyInstalled) return;
      (window as unknown as Record<string, unknown>)[installedKey] = true;
      if (active?.provider !== undefined && active.provider !== provider) {
        throw new Error("PTY fixture state provider does not match the current session identity");
      }

      type Listener = (event: Event) => void;

      class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readonly url: string;
        binaryType: BinaryType = "arraybuffer";
        readyState = FakeWebSocket.CONNECTING;
        sent: string[] = [];
        outputSeq = 0;
        cols = initialCols;
        rows = initialRows;

        constructor(url: string) {
          super();
          this.url = url;
          window.__ptySmoke.socket = this;
          setTimeout(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.dispatchEvent(new Event("open"));
          }, 0);
        }

        send(data: string): void {
          this.sent.push(data);
          window.__ptySmoke.sent.push(data);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return;
          }

          if (msg.type === "client_register") {
            if (msg.protocolVersion !== controlProtocolVersion) {
              throw new Error("invalid client_register fixture protocolVersion");
            }
            this.emitJson({
              type: "client_register_response",
              protocolVersion: controlProtocolVersion,
              status: "new",
            });
            return;
          }

          if (msg.type === "latency_web_relay_ping") {
            this.emitJson({
              type: "latency_web_relay_pong",
              requestId: msg.requestId,
              relayNow: Date.now(),
            });
            return;
          }

          if (msg.type === "proxy_list_request") {
            this.emitJson({
              type: "proxy_list_response",
              requestId: msg.requestId,
              proxies: [
                {
                  proxyId: "proxy-1",
                  name: "Smoke Proxy",
                  version: "0.9.0",
                  online: true,
                  sessions: [sessionId],
                },
              ],
            });
            return;
          }

          if (msg.type === "proxy_select") {
            this.emitJson({
              type: "proxy_select_response",
              requestId: msg.requestId,
              success: true,
              proxyId: "proxy-1",
              bindingId: `pty-binding-${String(msg.requestId)}`,
            });
            return;
          }

          if (msg.type === "proxy_info_request") {
            this.emitJson({
              type: "proxy_info",
              requestId: msg.requestId,
              homePath: "/tmp",
              agentCli: {
                claude: { available: true, command: "claude" },
                codex: { available: true, command: "codex" },
                kimi: { available: true, command: "kimi" },
              },
            });
            return;
          }

          if (msg.type === "session_history_request") {
            this.emitJson({
              type: "session_history_response",
              requestId: msg.requestId,
              success: true,
              sessions: [],
            });
            return;
          }

          if (msg.type === "session_messages_request") {
            this.emitJson({
              type: "session_history_messages",
              requestId: msg.requestId,
              sessionId,
              messages: [],
              hasMore: false,
            });
            return;
          }

          if (msg.type === "session_list_request") {
            this.emitJson({
              seq: 1,
              timestamp: Date.now(),
              source: "proxy",
              version: envelopeVersion,
              type: "session_list",
              payload: {
                sessions: [
                  {
                    sessionId,
                    kind: sessionKind,
                    cwd: sessionCwd,
                    mode: "pty",
                    provider,
                    ptyOwner,
                    state: "working",
                    lastActive: Date.now(),
                  },
                ],
              },
            });
            return;
          }

          if (msg.type === "agent_status_request") {
            this.emitJson({
              type: "agent_status",
              sessionId,
              payload: {
                provider,
                phase: "outputting",
                seq: 1,
                updatedAt: Date.now(),
              },
            });
            return;
          }

          if (msg.type === "session_resources_request") {
            this.emitJson({
              type: "file_tree_push",
              groups: [{ path: "/tmp", entries: [] }],
            });
            return;
          }

          if (msg.type === "session_subscribe") {
            if (typeof msg.requestId !== "string") return;
            this.emitSnapshot(msg.requestId, snapshotData);
          }
        }

        close(): void {
          this.readyState = FakeWebSocket.CLOSED;
          this.dispatchEvent(new Event("close"));
        }

        addEventListener(type: string, listener: Listener): void {
          super.addEventListener(type, listener as EventListener);
        }

        emitJson(payload: unknown): void {
          setTimeout(() => {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
          }, 0);
        }

        emitSnapshot(requestId: string, data: string): void {
          this.emitJson({
            type: "session_snapshot",
            sessionId,
            requestId,
            cols: this.cols,
            rows: this.rows,
            data,
            outputSeq: this.outputSeq,
          });
        }

        emitResize(cols: number, rows: number): void {
          this.cols = cols;
          this.rows = rows;
          this.outputSeq += 1;
          this.emitJson({
            type: "terminal_resize",
            sessionId,
            cols,
            rows,
            outputSeq: this.outputSeq,
          });
        }

        emitPty(data: string): void {
          this.emitPtyWithSeq(data, this.outputSeq + 1);
        }

        emitPtyWithSeq(data: string, outputSeq: number): void {
          this.outputSeq = Math.max(this.outputSeq, outputSeq);
          const sid = new TextEncoder().encode(sessionId);
          const payload = new TextEncoder().encode(data);
          const frame = new Uint8Array(1 + sid.length + 4 + payload.length);
          frame[0] = sid.length;
          frame.set(sid, 1);
          new DataView(frame.buffer).setUint32(1 + sid.length, outputSeq, true);
          frame.set(payload, 1 + sid.length + 4);
          this.dispatchEvent(new MessageEvent("message", { data: frame.buffer }));
        }
      }

      window.__ptySmoke = {
        sent: [],
        socket: null,
        sendPty(data: string) {
          this.socket?.emitPty(data);
        },
        sendPtyWithSeq(data: string, outputSeq: number) {
          this.socket?.emitPtyWithSeq(data, outputSeq);
        },
        resize(cols: number, rows: number) {
          this.socket?.emitResize(cols, rows);
        },
        setPtyState(state: "working" | "turn_complete" | "approval_wait") {
          this.socket?.emitJson({
            type: "pty_state",
            sessionId,
            payload: { state, seq: Date.now() },
          });
          this.socket?.emitJson({
            seq: Date.now(),
            sessionId,
            timestamp: Date.now(),
            source: "proxy",
            version: envelopeVersion,
            type: "session_status",
            payload: {
              sessionId,
              state:
                state === "approval_wait"
                  ? "waiting_approval"
                  : state === "turn_complete"
                    ? "idle"
                    : "working",
              lastActive: Date.now(),
            },
          });
        },
      };
      window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    },
    {
      activeKey: PTY_FAKE_RELAY_ACTIVE_KEY,
      sessionId: options.sessionId,
      provider,
      sessionKind,
      ptyOwner,
      snapshotData: options.snapshotData ?? "PTY SMOKE READY\r\n$ ",
      initialCols: options.cols,
      initialRows: options.rows,
      controlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      envelopeVersion: MESSAGE_ENVELOPE_VERSION,
      sessionCwd,
    },
  );
}

export async function expectPtyTerminalMounted(
  page: Page,
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 5_000;
  await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const screen = document.querySelector<HTMLElement>(
            '[data-slot="pty-host"] .xterm-screen',
          );
          const textarea = document.querySelector<HTMLTextAreaElement>(
            '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
          );
          if (!screen || !textarea) return false;
          return screen.clientWidth > 0 && screen.clientHeight > 0;
        });
      },
      { timeout },
    )
    .toBeTruthy();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__ptySmoke.socket?.sent.some((raw) => {
              try {
                return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
              } catch {
                return false;
              }
            }) ?? false,
        ),
      { timeout },
    )
    .toBe(true);
}

export async function readRawPtyInput(page: Page): Promise<string> {
  return page.evaluate(() =>
    window.__ptySmoke.sent
      .map((raw) => {
        try {
          return JSON.parse(raw) as { type?: string; data?: string };
        } catch {
          return {};
        }
      })
      .filter((msg) => msg.type === "remote_input_raw")
      .map((msg) => msg.data ?? "")
      .join(""),
  );
}

export type SetupPtyChatOptions = PtyFakeRelayOptions & {
  query?: string;
  withVisualViewportMock?: boolean;
  // mobile L4 spec 用 mobileBaseUrl, PC L3 用默认 BASE_URL.
  baseUrl?: string;
};

export async function setupPtyChat(page: Page, options: SetupPtyChatOptions): Promise<void> {
  if (options.withVisualViewportMock) {
    await installVisualViewportMock(page);
  }
  const query = options.query ?? "";
  const baseUrl = options.baseUrl ?? BASE_URL;
  let navNonce = 0;
  const url = () => {
    navNonce += 1;
    return `${baseUrl}/?ptyFakeRelay=${Date.now()}-${navNonce}#/chat/${options.sessionId}?mode=pty${query}`;
  };
  await installPtyFakeRelay(page, options);
  await page.goto(url());
  await resetLocalState(page);
  await installPtyFakeRelay(page, options);
  await page.goto(url());
}
