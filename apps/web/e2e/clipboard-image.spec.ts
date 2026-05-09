import { test, expect, type Locator } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "./helpers";

async function dispatchImagePaste(target: Locator): Promise<void> {
  await target.evaluate((node) => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    node.dispatchEvent(event);
  });
}

test.describe("clipboard image paste", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("JSON mode uploads pasted images and inserts a file token", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("inspect ");
    await dispatchImagePaste(input);

    const expectedPath = ".dev-anywhere/clipboard/test-sess/pasted-e2e.png";
    await expect(input).toHaveValue(`inspect @${expectedPath} `);

    const sent = await sentFakeRelayMessages(page);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "clipboard_image_upload",
        sessionId: "test-sess",
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      }),
    );
    expect(sent.some((msg) => msg.type === "user_input")).toBe(false);
  });

  test("PTY mode uploads pasted images and sends the returned file token as raw input", async ({
    page,
  }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await dispatchImagePaste(page.locator('[data-slot="pty-terminal"]'));

    const expectedPath = ".dev-anywhere/clipboard/claude-pty/pasted-e2e.png";
    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent
          .filter((msg) => msg.type === "remote_input_raw")
          .map((msg) => String(msg.data ?? ""))
          .join("");
      })
      .toBe(`@${expectedPath} `);

    const sent = await sentFakeRelayMessages(page);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "clipboard_image_upload",
        sessionId: "claude-pty",
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      }),
    );
  });
});
