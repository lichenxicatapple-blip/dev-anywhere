import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "./helpers";

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

  test("ArrowUp on empty recalls history entry", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");
    await page.evaluate(() => {
      localStorage.setItem(
        "cc_inputHistory:hist-sess",
        JSON.stringify(["first", "second", "third"]),
      );
    });
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.click();
    await page.keyboard.press("ArrowUp");
    await expect(input).toHaveValue("third");
  });

  test("sent messages are stored once in input history", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");
    const input = page.locator('[data-slot="input-bar"] textarea');
    await input.fill("remember this");
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter((msg) => msg.type === "user_input").length,
      )
      .toBeGreaterThanOrEqual(1);

    await input.fill("remember this");
    await page.keyboard.press("Enter");
    const history = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("cc_inputHistory:hist-sess") ?? "[]"),
    );
    expect(history).toEqual(["remember this"]);
  });
});
