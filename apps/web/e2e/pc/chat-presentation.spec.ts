import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "../helpers";

test.describe("chat 页异常态展示", () => {
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
    // 给出充足时间确认无误跳, 同时确认占位面板都没出
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/#\/chat\/claude-pty/);
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
