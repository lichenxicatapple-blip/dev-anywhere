import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "../helpers";

test.describe("chat 页异常态展示", () => {
  test("手机端手动结束和缺少退出码时仍准确展示退出信息", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await installFakeRelay(page, {
      recentExits: [
        {
          sessionId: "manually-ended",
          endedAt: Date.now(),
          kind: "terminal",
          provider: "codex",
          reason: "user-terminated",
        },
        {
          sessionId: "signal-ended",
          endedAt: Date.now(),
          kind: "agent",
          provider: "codex",
          reason: "process-exit",
          details: "Process exited (signal: SIGTERM)",
        },
      ],
    });
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/manually-ended?mode=pty`);
    const panel = page.locator('[data-slot="terminated-session-panel"]');
    await expect(panel.getByRole("heading", { name: "会话已结束" })).toBeVisible();
    await expect(panel.getByText("已手动结束此远程会话。")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("manual-exit-mobile.png"),
      animations: "disabled",
    });

    await page.goto(`${BASE_URL}/#/chat/signal-ended?mode=pty`);
    await expect(panel.getByText("进程已退出，可展开查看详情。")).toBeVisible();
    await expect(panel.getByText("未收到具体退出原因。")).toHaveCount(0);
    await panel.locator("summary").click();
    await expect(panel.locator("pre")).toHaveText("Process exited (signal: SIGTERM)");
    await page.screenshot({
      path: testInfo.outputPath("unknown-code-exit-mobile.png"),
      animations: "disabled",
    });
  });

  test("自动恢复和刷新后保留退出原因，错误详情可展开", async ({ page }, testInfo) => {
    const details =
      "Error: account/read failed during TUI bootstrap: workspace routing discovery timed out (code -32603)";
    await installFakeRelay(page, {
      recentExits: [
        {
          sessionId: "startup-failed",
          endedAt: Date.now(),
          kind: "agent",
          provider: "codex",
          reason: "process-exit",
          exitCode: 1,
          details,
        },
      ],
    });
    await page.addInitScript(() => {
      localStorage.setItem("dev-anywhere:last-chat-route", "/chat/startup-failed?mode=pty");
      localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    });
    await page.goto(BASE_URL);

    const panel = page.locator('[data-slot="terminated-session-panel"]');
    await expect(panel.getByRole("heading", { name: "终端异常退出" })).toBeVisible();
    await expect(page).toHaveURL(/#\/chat\/startup-failed/);
    await expect(panel.locator("pre")).toBeHidden();
    await panel.locator("summary").click();
    await expect(panel.getByText("退出码：1")).toBeVisible();
    await expect(panel.locator("pre")).toHaveText(details);
    await page.screenshot({ path: testInfo.outputPath("session-exit-details.png") });
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(panel.locator("pre")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("session-exit-details-mobile.png") });

    await page.reload();
    await expect(panel.getByRole("heading", { name: "终端异常退出" })).toBeVisible();
    await panel.locator("summary").click();
    await expect(panel.locator("pre")).toHaveText(details);
    await panel.getByRole("button", { name: "返回会话列表" }).click();
    await expect(page).toHaveURL(/#\/sessions/);
  });

  test("通道断开和进程退出使用同一详情展示，不推断进程已经结束", async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible();
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        seq: 1,
        timestamp: Date.now() + 1_000,
        source: "proxy",
        version: "1.0",
        type: "session_list",
        payload: {
          sessions: [
            {
              sessionId: "json-sess",
              state: "error",
              kind: "agent",
              mode: "json",
              provider: "cursor",
              cwd: "/tmp/project",
              lastActive: Date.now(),
            },
          ],
          recentExits: [
            {
              sessionId: "json-sess",
              endedAt: Date.now(),
              kind: "agent",
              provider: "cursor",
              reason: "connection-lost",
              details: "Worker channel closed",
            },
          ],
        },
      });
    });
    const panel = page.locator('[data-slot="failed-session-panel"]');
    await expect(panel.getByRole("heading", { name: "会话连接已中断" })).toBeVisible();
    await expect(panel.getByText(/暂时无法确认进程是否仍在运行/)).toBeVisible();
    await panel.locator("summary").click();
    await expect(panel.locator("pre")).toHaveText("Worker channel closed");
    await expect(page.locator('[data-slot="input-bar"]')).toHaveCount(0);
  });

  test("auto-restore 落到已死 session 时静默退到 /sessions + toast 提示", async ({ page }) => {
    await installFakeRelay(page);
    // 在 fake relay 之后注入 last-chat-route + 已保存 proxyId, 模拟"上次停在 /chat/dead-session
    // 然后开发机端清掉了这个 session"。fake-relay session_list 不含 dead-session, 进 chat
    // 后会触发 routeSessionEnded。
    await page.addInitScript(() => {
      localStorage.setItem("dev-anywhere:last-chat-route", "/chat/dead-session?mode=json");
      localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    });

    await page.goto(BASE_URL);

    await expect(page).toHaveURL(/#\/sessions/, { timeout: 15_000 });
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toHaveCount(0);
    await expect(
      page
        .locator('[data-sonner-toast], [role="status"]')
        .filter({ hasText: "上次会话已结束" })
        .first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("auto-restore 落到一个仍然活的 session 时不跳转, 不弹提示", async ({ page }) => {
    await installFakeRelay(page);
    // claude-pty 在 fake-relay 默认 session_list 里, 不应触发 redirect。
    await page.addInitScript(() => {
      localStorage.setItem("dev-anywhere:last-chat-route", "/chat/claude-pty?mode=pty");
      localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    });

    await page.goto(BASE_URL);

    await expect(page).toHaveURL(/#\/chat\/claude-pty/, { timeout: 15_000 });
    await expect.poll(() => page.url(), { timeout: 1_000 }).toMatch(/#\/chat\/claude-pty/);
    await expect(page.locator('[data-slot="terminated-session-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="connection-lost-panel"]')).toHaveCount(0);
  });

  test("用户主动敲 dead chat URL 时不静默跳, 仍展示 TerminatedSessionPanel", async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);

    // 直接 goto chat URL → 走 phase_machine cold-start 路径, 不经过 route-restore;
    // RESTORED_TARGET 不 set, 走 manual-nav 分支保留 TerminatedSessionPanel。
    await page.goto(`${BASE_URL}/#/chat/never-existed?mode=json`);

    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible({
      timeout: 10_000,
    });
    // URL 仍停在 /chat/never-existed, 没被静默改写
    await expect(page).toHaveURL(/#\/chat\/never-existed/);
  });

  test("relay 断开时 chat 主体被 ConnectionLostPanel(relay) 替代", async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
      timeout: 10_000,
    });

    // hold 让 ws 重连 socket 卡 CONNECTING, 关掉当前 socket → connected=false
    await page.evaluate(() => {
      window.__devAnywhereE2E?.holdConnections();
      window.__devAnywhereE2E?.socket?.close();
    });

    await expect(
      page.locator('[data-slot="connection-lost-panel"][data-variant="relay"]'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toHaveCount(0);
  });

  test("用户主动从 chat 退到 /sessions 后, 模拟冷启动不再被 auto-restore 拽回", async ({
    page,
  }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
    // 进活的 chat (会自动写入 last-chat-route)
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
      timeout: 10_000,
    });
    // 主动离开 chat 回到 sessions: AppShell 应清掉 last-chat-route
    await page.goto(`${BASE_URL}/#/sessions`);
    await expect(page).toHaveURL(/#\/sessions/, { timeout: 5_000 });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("dev-anywhere:last-chat-route")), {
        timeout: 5_000,
      })
      .toBeNull();

    // 模拟 PWA 冷启动: 清掉 sessionStorage 的 RESTORED 标记 + 跳到 root
    await page.evaluate(() => sessionStorage.removeItem("dev-anywhere:route-restored"));
    await page.goto(`${BASE_URL}/#/`);

    // 由于 last-chat-route 已被清掉, AppShell 不会拽回 /chat/json-sess; 应停在 / 或 sessions
    // (AppShell 会根据 proxy/会话状态自然推进, 但绝对不应是 chat URL)
    await expect.poll(() => page.url(), { timeout: 1_000 }).not.toMatch(/#\/chat\//);
  });

  test("proxy_offline 事件后 chat 主体被 ConnectionLostPanel(proxy) 替代", async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/json-sess?mode=json`);
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
      timeout: 10_000,
    });

    // 通过 fake-relay 同步 proxy 在线状态: 推 proxy_offline + 后续 proxy_list_response 也回 online:false,
    // 否则 phase-machine 重连验证段会把 proxyOnline 反弹回 true。
    await page.evaluate(() => {
      window.__devAnywhereE2E?.setProxyOnline(false);
    });

    await expect(
      page.locator('[data-slot="connection-lost-panel"][data-variant="proxy"]'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toHaveCount(0);
  });
});
