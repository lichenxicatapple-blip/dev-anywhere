import { expect, test } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

async function emitAssistantMessage(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((messageText) => {
    window.__devAnywhereE2E?.socket?.emitJson({
      seq: Date.now(),
      sessionId: "test-sess",
      timestamp: Date.now(),
      source: "proxy",
      version: "1",
      type: "assistant_message",
      payload: {
        text: messageText,
        isPartial: false,
      },
    });
  }, text);
}

test.describe("JSON inline path links", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
  });

  test("downloads a file from the inline path without rendering a duplicate bottom chip", async ({
    page,
  }) => {
    await emitAssistantMessage(page, "Please inspect README.md before continuing.");

    await expect(page.locator('[data-slot="file-download-links"]')).toHaveCount(0);
    await page.locator('[data-slot="inline-file-download-link"]', { hasText: "README.md" }).click();

    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page)).some(
          (msg) =>
            msg.type === "file_download_request" &&
            msg.sessionId === "test-sess" &&
            msg.path === "README.md",
        ),
      )
      .toBe(true);
  });

  test("previews an image from the inline path without rendering a duplicate bottom chip", async ({
    page,
  }) => {
    const path = ".dev-anywhere/clipboard/test-sess/shot.png";
    await emitAssistantMessage(page, `Open ${path} when ready.`);

    await expect(page.locator('[data-slot="image-preview-links"]')).toHaveCount(0);
    await page.locator('[data-slot="inline-image-preview-link"]', { hasText: path }).click();

    await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
    await expect(page.locator('[data-slot="image-preview-stage"]')).toBeVisible();
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page)).some(
          (msg) =>
            msg.type === "image_preview_request" &&
            msg.sessionId === "test-sess" &&
            msg.path === path,
        ),
      )
      .toBe(true);
  });
});
