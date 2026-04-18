import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("InputBar — slash command picker", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/test-sess?mode=json`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/chat/test-sess?mode=json`);
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
    await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);
    await resetLocalState(page);
  });

  test("ArrowUp on empty recalls history entry", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        "cc_inputHistory:hist-sess",
        JSON.stringify(["first", "second", "third"]),
      );
    });
    await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await page.keyboard.press("ArrowUp");
    await expect(input).toHaveValue("third");
  });
});
