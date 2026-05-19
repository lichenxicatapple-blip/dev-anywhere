// 真 Android Chrome: 会话菜单打开后点页面空白应关闭。之前 Radix modal menu
// 会把 body pointer-events 置为 none, touch outside dismiss 在手机上丢失。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";

test.describe("L4 mobile / chat overflow menu", () => {
  test.setTimeout(60_000);

  test("outside tap dismisses the chat overflow menu", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/json-sess?mode=json`);
    await emuPage.reload();

    await emuPage.getByRole("button", { name: "会话操作" }).click();
    const menu = emuPage.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => emuPage.evaluate(() => document.body.style.pointerEvents))
      .not.toBe("none");

    await emuPage.locator('[data-slot="message-list"]').click({ position: { x: 16, y: 120 } });
    await expect(menu).toHaveCount(0);
  });

  test("keeps menu width and font stepper compact on phone", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/json-sess?mode=json`);
    await emuPage.reload();

    await emuPage.getByRole("button", { name: "会话操作" }).click();
    const menu = emuPage.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible({ timeout: 30_000 });

    const geometry = await emuPage.evaluate(() => {
      const menuEl = document.querySelector<HTMLElement>('[data-slot="chat-overflow-menu"]');
      const fontRow = document.querySelector<HTMLElement>('[data-slot="chat-menu-font-row"]');
      const stepper = document.querySelector<HTMLElement>('[data-slot="chat-menu-font-stepper"]');
      if (!menuEl || !fontRow || !stepper) return null;
      const menuRect = menuEl.getBoundingClientRect();
      const rowRect = fontRow.getBoundingClientRect();
      const stepperRect = stepper.getBoundingClientRect();
      return {
        menuWidth: Math.round(menuRect.width),
        rowWidth: Math.round(rowRect.width),
        stepperWidth: Math.round(stepperRect.width),
        rowLeftInset: Math.round(rowRect.left - menuRect.left),
        rowRightSlack: Math.round(menuRect.right - rowRect.right),
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry!.menuWidth).toBeLessThanOrEqual(224);
    expect(geometry!.stepperWidth).toBeLessThan(geometry!.menuWidth - 80);
    expect(geometry!.rowWidth).toBeLessThan(geometry!.menuWidth - 60);
    expect(geometry!.rowLeftInset).toBeGreaterThanOrEqual(12);
    expect(geometry!.rowRightSlack).toBeGreaterThanOrEqual(60);
  });
});
