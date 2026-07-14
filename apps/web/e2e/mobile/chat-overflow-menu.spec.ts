// 真 Android Chrome: 会话菜单打开后点页面空白应关闭。之前 Radix modal menu
// 会把 body pointer-events 置为 none, touch outside dismiss 在手机上丢失。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";

test.describe("L4 mobile / chat overflow menu", () => {
  test.setTimeout(60_000);

  test("outside tap dismisses the menu and search opens without a hardware keyboard", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/hist-sess?mode=json`);
    await emuPage.reload();

    await emuPage.getByRole("button", { name: "会话操作" }).click();
    const menu = emuPage.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => emuPage.evaluate(() => document.body.style.pointerEvents))
      .not.toBe("none");

    await emuPage.locator('[data-slot="message-list"]').click({ position: { x: 16, y: 120 } });
    await expect(menu).toHaveCount(0);

    await emuPage.getByRole("button", { name: "会话操作" }).click();
    await emuPage.locator('[data-slot="chat-menu-find"]').click();
    const findInput = emuPage.getByRole("searchbox", { name: "查找内容" });
    await expect(findInput).toBeFocused();
    await findInput.fill("移动端历史问题");

    const activeMatch = emuPage.locator('[data-slot="message-row"][data-find-active="true"]');
    await expect(activeMatch).toContainText("移动端历史问题");
    await expect(activeMatch).toBeInViewport();
    await expect(emuPage.locator('[data-slot="chat-find-results"]')).toHaveText("1 / 1");
  });
});
