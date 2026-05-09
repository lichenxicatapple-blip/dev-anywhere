import { expect, test, type Locator } from "@playwright/test";
import {
  gotoWithFakeProxy,
  installFakeRelay,
  selectFakeProxy,
  sentFakeRelayMessages,
} from "./helpers";
import {
  MOBILE_VIEWPORTS,
  expectAllVisibleTouchTargets,
  expectNoHorizontalDocumentOverflow,
  expectTouchTarget,
  installVisualViewportMock,
} from "./mobile-helpers";

test.describe("mobile UX contract", () => {
  test.use({ viewport: MOBILE_VIEWPORTS.standard, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await installVisualViewportMock(page);
    await installFakeRelay(page);
  });

  test("proxy and session browsing are touch-safe without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('[data-slot="app-shell-header"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="mobile-brand-hero"] [data-slot="brand-typewriter"]'),
    ).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="mobile-settings-trigger"]'));
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(page.locator('[data-slot="proxy-item"]').first());

    await selectFakeProxy(page);
    await expect(page).toHaveURL(/\/sessions/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeVisible();
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).not.toContainText("左侧");
    await expectTouchTarget(page.locator('[data-slot="mobile-switch-proxy"]'));
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(page.locator('button:has-text("新建会话"):visible').last());
    await expectAllVisibleTouchTargets(
      page,
      '[data-slot="session-row"] button, [data-slot="history-row"]',
    );

    await page.locator('[data-slot="mobile-switch-proxy"]').click();
    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expect(page.locator('[data-slot="mobile-switch-proxy"]')).toHaveCount(0);
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("mobile shell settings opens the shared settings dialog", async ({ page }) => {
    await selectFakeProxy(page);
    const settings = page.locator('[data-slot="mobile-settings-trigger"]');

    await expect(settings).toBeVisible();
    await expectTouchTarget(settings);
    await settings.click();

    await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("direct mobile sessions route without a proxy returns to proxy selection", async ({
    page,
  }) => {
    await page.goto("/#/sessions");

    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="proxy-item"]').first());
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("direct mobile sessions route with a restorable proxy can return to proxy selection", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cc_proxyId", "proxy-1");
    });
    await page.goto("/#/sessions");

    await expect(page).toHaveURL(/\/sessions/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    const switchProxy = page.locator('[data-slot="mobile-switch-proxy"]');
    await expectTouchTarget(switchProxy);

    await switchProxy.click();
    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("create session uses a mobile-safe surface and keeps file picker usable", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    await page.locator('button:has-text("新建会话"):visible').last().click();

    const dialog = page.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);

    await expectTouchTarget(page.getByLabel("工作目录"));
    await expectTouchTarget(page.getByLabel("Agent CLI").getByRole("button", { name: /Claude/ }));
    await expectTouchTarget(page.getByLabel("交互方式").getByRole("button", { name: /终端模式/ }));
    const cliPathCard = page.locator('[data-slot="agent-cli-path-card"]');
    await expectTouchTarget(cliPathCard.getByRole("button", { name: "指定路径" }));
    const compactCliPathCardBox = await cliPathCard.boundingBox();
    expect(compactCliPathCardBox?.height ?? 0).toBeLessThanOrEqual(150);

    await cliPathCard.getByRole("button", { name: "指定路径" }).click();
    const cliPathInput = cliPathCard.locator('input[list^="agent-cli-path-"]');
    await expect(cliPathInput).toBeVisible();
    await expect
      .poll(() => cliPathInput.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
      .toBeGreaterThanOrEqual(16);
    await cliPathCard.getByRole("button", { name: "取消" }).click();

    await page.getByLabel("工作目录").focus();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="file-entry"]').first());
  });

  test("app shell follows expanded visual viewport when browser chrome moves", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const baseline = await page.locator('[data-slot="app-shell"]').evaluate((node) => {
      return node.getBoundingClientRect().height;
    });

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: window.innerHeight + 72,
        offsetTop: 0,
      }),
    );

    await expect
      .poll(() =>
        page.locator('[data-slot="app-shell"]').evaluate((node) => {
          return node.getBoundingClientRect().height;
        }),
      )
      .toBeGreaterThanOrEqual(baseline + 70);
  });

  test("json input survives visual viewport keyboard changes", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const input = page.getByLabel("输入聊天消息");
    await input.click();

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const root = page.locator("[data-keyboard-offset]").first();
    await expect(root).toHaveAttribute("data-keyboard-offset", /[1-9]\d*/);
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect
      .poll(() => listIsPinnedToBottom(page.locator('[data-slot="message-list"]')))
      .toBe(true);
    await expectNoHorizontalDocumentOverflow(page);

    await input.fill("/");
    await expect(page.locator('[data-slot="slash-command-picker"]')).toBeVisible();
    await expectTouchTarget(
      page.locator('[data-slot="slash-command-picker"] [data-slot="command-item"]').first(),
    );

    await input.fill("@");
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="insert"]')).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="file-entry"]').first());
  });

  test("browser chrome viewport changes do not create fake keyboard padding", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const input = page.getByLabel("输入聊天消息");
    await input.click();

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.86),
        offsetTop: 0,
      }),
    );

    const root = page.locator("[data-keyboard-offset]").first();
    await expect(root).toHaveAttribute("data-keyboard-offset", "0");
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("json history pages load on upward scroll in mobile chat", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await expect(page.getByText("移动端历史问题：请检查 JSON 渲染。")).toBeVisible();
    await expect(page.getByText("移动端历史回复：历史消息已经加载。")).toBeVisible();
    await expect(page.getByText("更早历史 01")).toHaveCount(0);
    await expectNoHorizontalDocumentOverflow(page);

    await list.evaluate((node) => {
      for (let i = 0; i < 3; i += 1) {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter(
            (msg) => msg.type === "session_messages_request" && msg.sessionId === "hist-sess",
          ).length,
      )
      .toBeGreaterThanOrEqual(2);

    await list.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByText("更早历史 01")).toBeVisible();
    await expect(page.locator('[data-slot="history-scrollback-status"]')).toContainText(
      "已到最早记录",
    );
    await expectNoHorizontalDocumentOverflow(page);

    const historyRequests = (await sentFakeRelayMessages(page)).filter(
      (msg) => msg.type === "session_messages_request" && msg.sessionId === "hist-sess",
    );
    expect(historyRequests[0]).toMatchObject({ limit: 50 });
    expect(historyRequests.filter((msg) => msg.before === "hist-before-13")).toHaveLength(1);
    expect(historyRequests[1]).toMatchObject({ before: "hist-before-13", limit: 50 });
  });

  test("json scroll trace records upward history scroll diagnostics", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json&jsonScrollTrace=1");

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-slot="json-scroll-trace-copy"]')).toBeVisible();

    await list.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace =
            (
              window as Window & {
                __devAnywhereJsonScrollTrace?: Array<{ event?: string }>;
              }
            ).__devAnywhereJsonScrollTrace ?? [];
          return trace.some(
            (entry) => entry.event === "scroll" || entry.event === "scroll:top-threshold",
          );
        }),
      )
      .toBeTruthy();
  });

  test("json upward scroll keeps virtual height stable for short mobile messages", async ({
    page,
  }) => {
    await gotoWithFakeProxy(page, "/#/chat/fo-sess?mode=json&jsonScrollTrace=1");

    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const sid = "fo-sess";
      for (let i = 0; i < 70; i += 1) {
        hooks.chat.addUserMessage(sid, {
          id: `mobile-jitter-u-${i}`,
          role: "user",
          text: `短消息 ${i}`,
          isPartial: false,
          timestamp: Date.now() + i,
          toolCalls: [],
        });
        hooks.chat.appendAssistantText(sid, `收到 ${i}`);
        hooks.chat.markTurnComplete(sid);
      }
    });

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await page.waitForTimeout(300);
    await list.evaluate((node) => {
      const el = node as HTMLElement;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(200);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 40);
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, -260);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(300);

    const totalSizeRange = await page.evaluate(() => {
      const trace =
        (
          window as Window & {
            __devAnywhereJsonScrollTrace?: Array<{ event?: string; totalSize?: number }>;
          }
        ).__devAnywhereJsonScrollTrace ?? [];
      const scrollTotals = trace
        .filter((entry) => entry.event === "scroll" && typeof entry.totalSize === "number")
        .map((entry) => entry.totalSize as number);
      return Math.max(...scrollTotals) - Math.min(...scrollTotals);
    });

    expect(totalSizeRange).toBeLessThan(180);
  });

  test("json send renders one user bubble and the assistant reply on mobile", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("移动端发送冒烟");
    const send = page.locator('[data-slot="send-button"][data-variant="send"]');
    await expectTouchTarget(send);
    await send.click();

    const userBubbles = page.locator('[data-slot="message-bubble"][data-role="user"]', {
      hasText: "移动端发送冒烟",
    });
    await expect(userBubbles).toHaveCount(1);
    await expect(
      page.locator('[data-slot="message-bubble"][data-role="assistant"]', { hasText: "收到。" }),
    ).toHaveCount(1);
    await expectNoHorizontalDocumentOverflow(page);

    const sent = await sentFakeRelayMessages(page);
    const userInput = sent.find((msg) => msg.type === "user_input");
    expect(userInput).toBeTruthy();
    expect((userInput?.payload as { messageId?: string } | undefined)?.messageId).toMatch(
      /^test-sess-user-/,
    );
  });

  test("json chat font size controls both bubbles and the input field", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    const bubbleContent = page.locator('[data-slot="message-bubble"] [style*="font-size"]').first();
    await expect(bubbleContent).toBeVisible();

    const readFontSize = (locator: typeof input) =>
      locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const inputBefore = await readFontSize(input);
    const bubbleBefore = await readFontSize(bubbleContent);
    expect(inputBefore).toBeGreaterThanOrEqual(16);
    expect(bubbleBefore).toBe(inputBefore);

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(page.getByText("聊天字号")).toBeVisible();
    const largerFont = page.locator('[data-slot="chat-menu-font-larger"]');
    await expectTouchTarget(largerFont);
    await largerFont.click();

    await expect.poll(() => readFontSize(bubbleContent)).toBe(bubbleBefore + 1);
    await expect.poll(() => readFontSize(input)).toBe(inputBefore + 1);
  });

  test("approval card is touch-safe and can deny from mobile", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");

    const card = page.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await expect(card).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(card.getByRole("button", { name: "展开详情" }));
    await expectTouchTarget(card.getByRole("button", { name: "始终允许", exact: true }));
    await expectTouchTarget(card.getByRole("button", { name: "拒绝", exact: true }));
    await expectTouchTarget(card.getByRole("button", { name: "允许", exact: true }));

    await card.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter((msg) => msg.type === "tool_deny").length,
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("pty terminal is visible and orientation-safe", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);

    const terminalBox = await page.locator('[data-slot="pty-terminal"]').boundingBox();
    expect(terminalBox?.height ?? 0).toBeGreaterThan(180);
    const hostBox = await page.locator('[data-slot="pty-host"]').boundingBox();
    expect(hostBox?.width ?? 0).toBeGreaterThan(300);

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(page.locator('[data-slot="chat-menu-font-control"]')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
    await page.keyboard.press("Escape");

    await page.setViewportSize(MOBILE_VIEWPORTS.landscape);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });
});

async function listIsPinnedToBottom(list: Locator): Promise<boolean> {
  return list.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 8);
}
