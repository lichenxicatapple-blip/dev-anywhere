// 移动端 master-detail 导航 e2e: sessions list ↔ chat detail 双向, URL 同步.
// 这条 spec 测的是 navigation 行为 (mobile 视口下 list 和 detail 不同时可见),
// 与 mobile-contract.spec.ts 的视口契约 / touch-target 维度互补.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";

test.describe("L4 mobile / master-detail navigation", () => {
  test.setTimeout(60_000);

  test("clicking a session row enters chat detail; back button returns to list", async ({
    emuPage,
  }) => {
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await installFakeRelay(emuPage);
    // emu Chrome 是 long-lived page (cdp.ts 复用 contexts[0].pages[0]),
    // addInitScript 只在 navigation 生效, reload 一次让 fake relay 注入.
    await emuPage.reload();

    // mobile 视口默认进 proxy 选择 hero. fakeRelay 注入 1 个 fake proxy.
    await expect(emuPage.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]')).toBeVisible({
      timeout: 30_000,
    });
    await emuPage
      .locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible')
      .last()
      .click();
    await expect(emuPage).toHaveURL(/\/sessions/, { timeout: 15_000 });

    // sessions 列表能看到至少一条 row, 触屏可点.
    const firstRow = emuPage.locator('[data-slot="session-row"]:visible').first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    const rowSessionId = await firstRow.getAttribute("data-session-id");
    expect(rowSessionId).toBeTruthy();

    // 点 row 进 detail. URL hash 应进 /chat/<id>.
    await firstRow.click();
    await expect(emuPage).toHaveURL(new RegExp(`#/chat/${rowSessionId}`), { timeout: 15_000 });
    // mobile 视口 detail 视图盖住 list (chat-* slot 之一可见, session-row 隐藏).
    await expect(emuPage.locator('[data-slot="session-row"]:visible')).toHaveCount(0);

    // 浏览器后退回 list. URL 回到 /sessions.
    await emuPage.goBack();
    await expect(emuPage).toHaveURL(/\/sessions/, { timeout: 15_000 });
    await expect(emuPage.locator('[data-slot="session-row"]:visible').first()).toBeVisible();
  });
});
