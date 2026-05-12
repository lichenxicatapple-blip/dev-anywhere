// 移动端 chat 异常态展示 e2e: 真 Android Chrome over CDP, 验 PWA 冷启动场景下
// auto-restore 落到已死 session 时静默退到 /sessions, 以及 ConnectionLostPanel 在
// 移动视口下能被 layout 正常承接 (无水平溢出 / 内容可见)。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, selectFakeProxy } from "../helpers";
import { expectNoHorizontalDocumentOverflow } from "../mobile-helpers";

test.describe("L4 mobile / chat presentation", () => {
  test.setTimeout(90_000);

  test("auto-restore 落到已死 session 时静默退到 /sessions", async ({ emuPage }) => {
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await installFakeRelay(emuPage);
    await emuPage.addInitScript(() => {
      localStorage.setItem("dev-anywhere:last-chat-route", "/chat/dead-session?mode=json");
      localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
      // sessionStorage 跨 reload 持久, 清掉 RESTORED_FLAG 才能触发 cold-start 路径。
      sessionStorage.removeItem("dev-anywhere:route-restored");
    });
    await emuPage.reload();

    await expect(emuPage).toHaveURL(/#\/sessions/, { timeout: 30_000 });
    await expect(emuPage.locator('[data-slot="terminated-session-panel"]')).toHaveCount(0);
    await expect(
      emuPage
        .locator('[data-sonner-toast], [role="status"]')
        .filter({ hasText: "上次会话已结束" })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ConnectionLostPanel(proxy) 在移动视口下完整可见, 不水平溢出", async ({ emuPage }) => {
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await installFakeRelay(emuPage);
    await emuPage.reload();
    await selectFakeProxy(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/json-sess?mode=json`);
    await expect(emuPage.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
      timeout: 30_000,
    });

    await emuPage.evaluate(() => {
      window.__devAnywhereE2E?.setProxyOnline(false);
    });

    const panel = emuPage.locator('[data-slot="connection-lost-panel"][data-variant="proxy"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("开发机未连接")).toBeVisible();
    await expectNoHorizontalDocumentOverflow(emuPage);
    // input bar 已被替代, 不应再可见
    await expect(emuPage.locator('[data-slot="input-bar"][data-mode="json"]')).toHaveCount(0);
  });
});
