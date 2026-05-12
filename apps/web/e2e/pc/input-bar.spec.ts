import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

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

test.describe("InputBar — keyboard submit behavior", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
  });

  test.describe("desktop keyboard", () => {
    test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

    test("plain Enter sends the message", async ({ page }) => {
      const input = page.getByLabel("输入聊天消息");
      await input.fill("桌面 Enter 发送");
      await input.press("Enter");

      await expect(
        page.locator('[data-slot="message-bubble"][data-role="user"]', {
          hasText: "桌面 Enter 发送",
        }),
      ).toHaveCount(1);
      await expect.poll(() => userInputTexts(page)).toEqual(["桌面 Enter 发送"]);
    });
  });

  test.describe("mobile soft keyboard", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("plain Enter inserts a newline and the send button sends multiline text", async ({
      page,
    }) => {
      const input = page.getByLabel("输入聊天消息");
      await input.fill("第一行");
      await input.press("Enter");

      await expect(input).toHaveValue("第一行\n");
      await expect.poll(() => userInputTexts(page)).toEqual([]);

      await input.type("第二行");
      await page.locator('[data-slot="send-button"][data-variant="send"]').click();

      await expect(
        page.locator('[data-slot="message-bubble"][data-role="user"]', {
          hasText: "第一行\n第二行",
        }),
      ).toHaveCount(1);
      await expect.poll(() => userInputTexts(page)).toEqual(["第一行\n第二行"]);
    });
  });
});

async function userInputTexts(page: Parameters<typeof sentFakeRelayMessages>[0]) {
  return (await sentFakeRelayMessages(page))
    .filter((msg) => msg.type === "user_input")
    .map((msg) => (msg.payload as { text?: string } | undefined)?.text ?? "");
}
