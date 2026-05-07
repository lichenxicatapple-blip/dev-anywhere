import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

const SESSION_ID = "pty-smoke";

async function installFakeRelay(page: import("@playwright/test").Page): Promise<void> {
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
          this.outputSeq += 1;
          const sid = new TextEncoder().encode(sessionId);
          const payload = new TextEncoder().encode(data);
          const frame = new Uint8Array(1 + sid.length + 4 + payload.length);
          frame[0] = sid.length;
          frame.set(sid, 1);
          new DataView(frame.buffer).setUint32(1 + sid.length, this.outputSeq, true);
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
        resize(cols: number, rows: number) {
          this.socket?.emitResize(cols, rows);
        },
        setPtyState(state: "working" | "turn_complete" | "approval_wait" | "mid_pause") {
          this.socket?.emitJson({ type: "pty_state", sessionId, payload: { state } });
        },
      };
      window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    },
    { sessionId: SESSION_ID },
  );
}

async function expectTerminalMounted(page: import("@playwright/test").Page): Promise<void> {
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

test.describe("PTY browser smoke", () => {
  test("renders terminal, sends raw input, scrolls, and recovers after resize", async ({
    page,
  }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-bar-region"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-connecting"]')).toHaveCount(0);
    await expectTerminalMounted(page);

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        page.evaluate(() =>
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
        ),
      )
      .toContain("abc\r");

    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 90 }, (_, i) => `line ${String(i).padStart(2, "0")}\r\n`).join(""),
      );
    });
    await expect(page.locator('[data-slot="pty-scrollbar"]')).toHaveClass(/opacity-100/);

    await page.locator('[data-slot="pty-terminal"]').hover();
    await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1200 }));
      (el as HTMLElement).scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator('[data-slot="back-to-bottom"]')).toBeVisible();
    const scrollTopBeforeNewFrame = await page
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => {
        return (el as HTMLElement).scrollTop;
      });

    await page.evaluate(() => {
      window.__ptySmoke.sendPty("new output while reviewing history\r\n");
    });
    await expect(page.locator('[aria-label="有新消息"]')).toBeVisible();
    const scrollTopAfterNewFrame = await page
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => {
        return (el as HTMLElement).scrollTop;
      });
    expect(scrollTopAfterNewFrame).toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);

    await page.locator('[data-slot="back-to-bottom"]').click();
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect
      .poll(async () =>
        page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollTop + node.clientHeight >= node.scrollHeight - 8;
        }),
      )
      .toBeTruthy();
    const beforeApprovalChrome = await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
    });
    await page.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    const afterApprovalChrome = await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
    });
    expect(afterApprovalChrome.clientHeight).toBe(beforeApprovalChrome.clientHeight);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThan(0);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThanOrEqual(beforeApprovalChrome.scrollTop - 8);

    await page.evaluate(() => window.__ptySmoke.resize(100, 30));
    await expectTerminalMounted(page);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            window.__ptySmoke.sent.filter((raw) => {
              try {
                return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
              } catch {
                return false;
              }
            }).length,
        ),
      )
      .toBeGreaterThanOrEqual(2);
  });
});
