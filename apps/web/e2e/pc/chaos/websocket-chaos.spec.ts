import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  installFakeRelay,
  openCreateAgentSessionDialog,
  selectFakeProxy,
  sentFakeRelayMessages,
} from "../../helpers";
import { expectPtyAtBottom, ptyTerminal, readPtyScrollMetrics } from "../../pty-scroll-helpers";

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

async function waitForAnimationFrames(
  page: import("@playwright/test").Page,
  count = 2,
): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (frames >= frameCount) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
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

    await holdNextConnectionAndDropSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );

    await releaseHeldConnections(page);
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

    await holdNextConnectionAndDropSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );

    await releaseHeldConnections(page);
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

  test("reselects and resubscribes PTY after a graceful proxy restart", async ({ page }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toBeVisible();
    const beforeRestartMessageCount = (await sentFakeRelayMessages(page)).length;

    await page.evaluate(() => {
      const socket = window.__devAnywhereE2E?.socket;
      socket?.emitJson({ type: "proxy_offline", proxyId: "proxy-1" });
      socket?.emitJson({
        type: "proxy_list_response",
        proxies: [
          {
            proxyId: "proxy-1",
            name: "Local Mac",
            online: true,
            sessions: ["claude-pty", "codex-pty", "json-sess"],
          },
        ],
      });
    });

    await expect
      .poll(async () => {
        const sent = (await sentFakeRelayMessages(page)).slice(beforeRestartMessageCount);
        return sent.some((msg) => msg.type === "proxy_select");
      })
      .toBeTruthy();
    await expect
      .poll(async () => {
        const sent = (await sentFakeRelayMessages(page)).slice(beforeRestartMessageCount);
        return sent.some(
          (msg) => msg.type === "session_subscribe" && msg.sessionId === "claude-pty",
        );
      })
      .toBeTruthy();
    await expect(page.locator('[data-slot="pty-subscribe-delayed"]')).toHaveCount(0);
    await expect(
      page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toBeVisible();
  });

  test("does not force-follow PTY output after reconnect when user is reviewing history", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 120 },
          (_, i) => `history line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect(page.locator('[data-slot="pty-scrollbar"]')).toHaveClass(/opacity-100/);

    const terminal = page.locator('[data-slot="pty-terminal"]');
    await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
      node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -600 }));
    });
    await expect(page.locator('[data-slot="back-to-bottom"]')).toBeVisible();
    const scrollTopBeforeReconnect = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);

    await holdNextConnectionAndDropSocket(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
      "data-state",
      "disconnected",
    );
    await releaseHeldConnections(page);
    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute("data-state", "idle", {
      timeout: 5_000,
    });

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty("claude-pty", "new output after reconnect\r\n");
    });
    await expect
      .poll(() => page.evaluate(() => window.__ccTest?.pty.serialize("claude-pty") ?? ""))
      .toContain("new output after reconnect");
    await expect(page.locator('[data-slot="back-to-bottom-new-indicator"]')).toBeVisible();
    const scrollTopAfterReconnectOutput = await terminal.evaluate(
      (el) => (el as HTMLElement).scrollTop,
    );
    expect(scrollTopAfterReconnectOutput).toBeLessThanOrEqual(scrollTopBeforeReconnect + 8);
  });

  test("restores PTY bottom when page resume fires before reconnect reattaches terminal", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/claude-pty?mode=pty`);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 120 },
          (_, i) => `resume reconnect line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expectPtyAtBottom(page);

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await ptyTerminal(page).evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect
      .poll(() => readPtyScrollMetrics(page).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(100);

    await holdNextConnectionAndDropSocket(page);
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await waitForAnimationFrames(page);
    await releaseHeldConnections(page);

    await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute("data-state", "idle", {
      timeout: 5_000,
    });
    await expectPtyAtBottom(page);
  });

  test("does not queue request-response session creation while disconnected", async ({ page }) => {
    // 移动 UX 单栏路由下 proxy 断线会把"新建会话"对话框整体卸载回退到 proxy-selection,
    // 这条 invariant 在 mobile 路径上以另一种 UX 表达(整个对话被卸载),不是相同测试形态。
    // 限定到桌面视口 + 非触屏环境验证 relay 不入队的契约。
    const isDesktopUX = await page.evaluate(
      () =>
        window.matchMedia("(min-width: 768px)").matches &&
        !window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );
    if (!isDesktopUX) {
      test.skip(
        true,
        "mobile/touch UX: 断线时新建会话弹窗不保留,relay 不入队的契约由 desktop 验证",
      );
    }
    await selectFakeProxy(page);
    await openCreateAgentSessionDialog(page);
    await page.getByLabel("工作目录").fill("/home/dev/projects/sample-app");

    await holdNextConnectionAndDropSocket(page);
    await page
      .getByRole("dialog", { name: "新建会话" })
      .getByRole("button", { name: "创建" })
      .click();

    await expect(page.getByRole("button", { name: "创建" })).toBeEnabled();
    await expect(page.getByText("连接已断开")).toBeVisible();
    await releaseHeldConnections(page);
    await expect(page).toHaveURL(/#\/?$/);

    const sent = await sentFakeRelayMessages(page);
    expect(sent.filter((msg) => msg.type === "session_create")).toHaveLength(0);
  });
});
