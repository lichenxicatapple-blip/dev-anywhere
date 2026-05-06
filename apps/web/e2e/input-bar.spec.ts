import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "./helpers";

test.describe("InputBar — slash command picker", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
  });

  test("typing / opens SlashCommandPicker", async ({ page }) => {
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await input.fill("/");
    const picker = page.locator('[data-slot="slash-command-picker"]');
    await expect(picker).toBeVisible();
  });

  test("Escape closes picker", async ({ page }) => {
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await input.fill("/status");
    await page.keyboard.press("Escape");
    const picker = page.locator('[data-slot="slash-command-picker"]');
    await expect(picker).not.toBeVisible();
  });

  test("send button is disabled when empty", async ({ page }) => {
    const send = page.locator('[data-slot="send-button"]');
    await expect(send).toBeDisabled();
  });
});

test.describe("InputBar — history recall", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test.skip("ArrowUp on empty recalls history entry", async ({ page }) => {
    // 当前 InputBar 没有实现历史召回；保留为显式产品缺口，避免伪造覆盖。
    await page.evaluate(() => {
      localStorage.setItem(
        "cc_inputHistory:hist-sess",
        JSON.stringify(["first", "second", "third"]),
      );
    });
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await page.keyboard.press("ArrowUp");
    await expect(input).toHaveValue("third");
  });
});
