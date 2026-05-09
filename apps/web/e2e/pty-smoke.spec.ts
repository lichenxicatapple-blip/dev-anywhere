import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";
import { expectTouchTarget } from "./mobile-helpers";

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
        setPtyState(state: "working" | "turn_complete" | "approval_wait" | "mid_pause") {
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

async function readRawPtyInput(page: import("@playwright/test").Page): Promise<string> {
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

test.describe("PTY browser smoke", () => {
  test("ignores stale render snapshots and reorders duplicate PTY frames by outputSeq", async ({
    page,
  }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectTerminalMounted(page);

    await page.evaluate(() => {
      window.__ptySmoke.socket?.emitJson({
        type: "session_snapshot",
        sessionId: "pty-smoke",
        requestId: "stale-request",
        cols: 80,
        rows: 24,
        data: "STALE SNAPSHOT SHOULD NOT RENDER\r\n",
        outputSeq: 99,
      });
      window.__ptySmoke.sendPtyWithSeq("SEQ-2\r\n", 2);
      window.__ptySmoke.sendPtyWithSeq("SEQ-1\r\n", 1);
      window.__ptySmoke.sendPtyWithSeq("DUPLICATE-SEQ-1-SHOULD-NOT-RENDER\r\n", 1);
      window.__ptySmoke.sendPtyWithSeq("OLDER-SEQ-0-SHOULD-NOT-RENDER\r\n", 0);
      window.__ptySmoke.sendPtyWithSeq("DUPLICATE-SEQ-2-SHOULD-NOT-RENDER\r\n", 2);
      window.__ptySmoke.sendPtyWithSeq("SEQ-4\r\n", 4);
      window.__ptySmoke.sendPtyWithSeq("SEQ-3\r\n", 3);
    });

    await expect
      .poll(() => page.evaluate(() => window.__ccTest?.pty.serialize("pty-smoke") ?? ""))
      .toContain("SEQ-4");

    const screen = await page.evaluate(() => window.__ccTest?.pty.serialize("pty-smoke") ?? "");
    const seq1Index = screen.indexOf("SEQ-1");
    const seq2Index = screen.indexOf("SEQ-2");
    const seq3Index = screen.indexOf("SEQ-3");
    const seq4Index = screen.indexOf("SEQ-4");
    expect(screen).toContain("SEQ-1");
    expect(screen).toContain("SEQ-2");
    expect(screen).toContain("SEQ-3");
    expect(screen).toContain("SEQ-4");
    expect(seq1Index).toBeLessThan(seq2Index);
    expect(seq2Index).toBeLessThan(seq3Index);
    expect(seq3Index).toBeLessThan(seq4Index);
    expect(screen).not.toContain("STALE SNAPSHOT SHOULD NOT RENDER");
    expect(screen).not.toContain("DUPLICATE-SEQ-1-SHOULD-NOT-RENDER");
    expect(screen).not.toContain("OLDER-SEQ-0-SHOULD-NOT-RENDER");
    expect(screen).not.toContain("DUPLICATE-SEQ-2-SHOULD-NOT-RENDER");
  });

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
    await expect
      .poll(() =>
        page
          .locator('[data-slot="pty-terminal"]')
          .evaluate((el) => getComputedStyle(el).touchAction),
      )
      .toBe("pan-x pan-y");
    const touchEditingSurface = await page.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => readRawPtyInput(page))
      .toContain(touchEditingSurface ? "abc\n" : "abc\r");
    if (touchEditingSurface) {
      const controls = page.locator('[data-slot="pty-mobile-controls"]');
      await expect(controls).toBeVisible();
      await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-clear"]'));
      await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-left"]'));
      await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-enter"]'));
      await page.locator('[data-slot="pty-mobile-key-clear"]').click();
      await page.locator('[data-slot="pty-mobile-key-left"]').click();
      await page.locator('[data-slot="pty-mobile-key-right"]').click();
      await page.locator('[data-slot="pty-mobile-key-up"]').click();
      await page.locator('[data-slot="pty-mobile-key-down"]').click();
      await page.locator('[data-slot="pty-mobile-key-enter"]').click();
      await expect
        .poll(() => readRawPtyInput(page))
        .toContain("abc\n\x15\x1b[D\x1b[C\x1b[A\x1b[B\r");

      await page
        .locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]')
        .evaluate((el) => (el as HTMLTextAreaElement).blur());
      await expect(controls).toHaveCount(0);
    } else {
      await expect(page.locator('[data-slot="pty-mobile-controls"]')).toHaveCount(0);
    }

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
    const backToBottomScrollbarGap = async () => {
      const button = await page.locator('[data-slot="back-to-bottom"]').boundingBox();
      const scrollbar = await page.locator('[data-slot="pty-scrollbar"]').boundingBox();
      if (!button || !scrollbar) return -1;
      return Math.round(scrollbar.x - (button.x + button.width));
    };
    await expect.poll(backToBottomScrollbarGap).toBeGreaterThanOrEqual(12);
    await expect.poll(backToBottomScrollbarGap).toBeLessThanOrEqual(20);
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
    expect(afterApprovalChrome.scrollTop).toBeGreaterThanOrEqual(
      beforeApprovalChrome.scrollTop - 8,
    );

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

  test("does not pin users to bottom when PTY output arrives during native touch scroll", async ({
    page,
  }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectTerminalMounted(page);
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 140 }, (_, i) => `stream line ${String(i).padStart(3, "0")}\r\n`).join(
          "",
        ),
      );
    });
    const terminal = page.locator('[data-slot="pty-terminal"]');
    await expect
      .poll(() =>
        terminal.evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollHeight - node.clientHeight;
        }),
      )
      .toBeGreaterThan(0);

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");

    await terminal.evaluate((el) => {
      const touchstart = new Event("touchstart", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchstart, "touches", { value: [{ clientY: 520 }] });
      el.dispatchEvent(touchstart);
    });
    await page.evaluate(() => {
      window.__ptySmoke.sendPty("frame-before-native-scroll\r\n");
    });
    await terminal.evaluate((el) => {
      const touchmove = new Event("touchmove", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchmove, "touches", { value: [{ clientY: 460 }] });
      el.dispatchEvent(touchmove);
      const node = el as HTMLElement;
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(0, maxScrollTop - 600);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .not.toBe("Terminal input");
    const scrollTopBeforeNewFrame = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);

    await page.evaluate(() => {
      window.__ptySmoke.sendPty("frame-after-native-scroll\r\n");
    });

    await expect(page.locator('[aria-label="有新消息"]')).toBeVisible();
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);
  });

  test("collects PTY scroll trace when diagnostics are enabled", async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty&ptyScrollTrace=1`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty&ptyScrollTrace=1`);

    await expectTerminalMounted(page);
    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toBeVisible();

    const terminal = page.locator('[data-slot="pty-terminal"]');
    await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 120);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace = window.__devAnywherePtyScrollTrace ?? [];
          return trace.some((entry) => entry.event === "container-scroll");
        }),
      )
      .toBeTruthy();
  });

  test("enables PTY scroll trace after hash query changes", async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectTerminalMounted(page);
    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.location.hash = `${window.location.hash}&ptyScrollTrace=1`;
    });

    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toBeVisible();

    await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 120);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace = window.__devAnywherePtyScrollTrace ?? [];
          return trace.some((entry) => entry.event === "container-scroll");
        }),
      )
      .toBeTruthy();
  });

  test("keeps xterm at the real last viewport when small fonts leave extra vertical space", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_ptyFontSize", "10");
    });
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectTerminalMounted(page);
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 220 },
          (_, i) => `small font line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(() => page.evaluate(() => window.__ccTest?.pty.metrics("pty-smoke")?.fontSize))
      .toBe(10);

    await page.locator('[data-slot="pty-terminal"]').hover();
    await page.mouse.wheel(0, -1800);
    await expect
      .poll(() =>
        page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollHeight - node.clientHeight - node.scrollTop;
        }),
      )
      .toBeGreaterThan(0);

    await page.mouse.wheel(0, 5000);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const node = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
          const term = window.__ccTestPtyTerminals?.get("pty-smoke");
          if (!node || !term) return null;
          return {
            bottomGap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
          };
        }),
      )
      .toEqual(expect.objectContaining({ bottomGap: 0, viewportY: expect.any(Number) }));

    const metrics = await page.evaluate(() => {
      const term = window.__ccTestPtyTerminals?.get("pty-smoke");
      return term
        ? { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY }
        : null;
    });
    expect(metrics?.viewportY).toBe(metrics?.baseY);
  });

  test("preserves IME-transformed full-width punctuation in raw PTY input", async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectTerminalMounted(page);
    const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await input.focus();
    await input.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ",",
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          data: "，",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });

    await expect.poll(() => readRawPtyInput(page)).toBe("，");

    await input.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ".",
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          data: ".",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });

    await expect.poll(() => readRawPtyInput(page)).toBe("，.");
  });
});
