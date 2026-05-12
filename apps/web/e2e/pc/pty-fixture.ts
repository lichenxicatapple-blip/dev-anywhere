// PTY spec 共用的 fake relay + chat setup helper.
// 每个 spec 用自己的 sessionId, 通过 setupPtyChat 完成 init+reload+resetLocal 流程.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "../helpers";
import { installVisualViewportMock } from "../mobile-helpers";

export type PtyFakeRelayOptions = {
  sessionId: string;
};

export async function installPtyFakeRelay(page: Page, options: PtyFakeRelayOptions): Promise<void> {
  await page.addInitScript(
    ({ sessionId }) => {
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
            this.emitJson({ type: "client_register_response", status: "new" });
            return;
          }

          if (msg.type === "proxy_list_request") {
            this.emitJson({
              type: "proxy_list_response",
              requestId: msg.requestId,
              proxies: [
                { proxyId: "proxy-1", name: "Smoke Proxy", online: true, sessions: [sessionId] },
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
            });
            return;
          }

          if (msg.type === "session_list") {
            this.emitJson({
              seq: 1,
              sessionId,
              timestamp: Date.now(),
              source: "proxy",
              version: "1",
              type: "session_list",
              payload: {
                sessions: [
                  {
                    sessionId,
                    mode: "pty",
                    provider: "claude",
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
                provider: "claude",
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
            this.emitSnapshot(String(msg.requestId ?? ""), "PTY SMOKE READY\r\n$ ");
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
            cols: 80,
            rows: 24,
            data,
            outputSeq: this.outputSeq,
          });
        }

        emitResize(cols: number, rows: number): void {
          this.emitJson({ type: "terminal_resize", sessionId, cols, rows });
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
          this.socket?.emitJson({ type: "pty_state", sessionId, payload: { state } });
          this.socket?.emitJson({
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
    { sessionId: options.sessionId },
  );
}

export async function expectPtyTerminalMounted(page: Page): Promise<void> {
  await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
        const textarea = document.querySelector<HTMLTextAreaElement>(
          '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
        );
        if (!screen || !textarea) return false;
        return screen.clientWidth > 0 && screen.clientHeight > 0;
      });
    })
    .toBeTruthy();
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

export type SetupPtyChatOptions = {
  sessionId: string;
  query?: string;
  withVisualViewportMock?: boolean;
};

export async function setupPtyChat(page: Page, options: SetupPtyChatOptions): Promise<void> {
  if (options.withVisualViewportMock) {
    await installVisualViewportMock(page);
  }
  const query = options.query ?? "";
  const url = `${BASE_URL}/#/chat/${options.sessionId}?mode=pty${query}`;
  await installPtyFakeRelay(page, { sessionId: options.sessionId });
  await page.goto(url);
  await resetLocalState(page);
  await installPtyFakeRelay(page, { sessionId: options.sessionId });
  await page.goto(url);
}
