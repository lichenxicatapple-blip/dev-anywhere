import { test, expect, type Locator } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

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

async function dispatchLargeImagePaste(target: Locator): Promise<number> {
  return target.evaluate(async (node) => {
    const width = 3000;
    const height = 2000;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable");

    const pixels = context.createImageData(width, height);
    let state = 0x12345678;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.data[offset] = state & 0xff;
      pixels.data[offset + 1] = (state >>> 8) & 0xff;
      pixels.data[offset + 2] = (state >>> 16) & 0xff;
      pixels.data[offset + 3] = 0xff;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) =>
        result ? resolve(result) : reject(new Error("PNG encode failed")),
      );
    });
    const file = new File([blob], "large-screenshot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return file.size;
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
        type: "remote_file_upload_url_request",
        sessionId: "test-sess",
        kind: "clipboard_image",
        mimeType: "image/png",
        fileName: "shot.png",
        size: 3,
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
        type: "remote_file_upload_url_request",
        sessionId: "claude-pty",
        kind: "clipboard_image",
        mimeType: "image/png",
        fileName: "shot.png",
        size: 3,
      }),
    );
  });

  test("large static images are compressed before upload", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    const originalSize = await dispatchLargeImagePaste(input);
    expect(originalSize).toBeGreaterThan(2 * 1024 * 1024);

    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent.find(
          (message) =>
            message.type === "remote_file_upload_url_request" &&
            message.fileName === "large-screenshot.webp",
        );
      })
      .toEqual(
        expect.objectContaining({
          sessionId: "test-sess",
          kind: "clipboard_image",
          mimeType: "image/webp",
        }),
      );

    const sent = await sentFakeRelayMessages(page);
    const upload = sent.find(
      (message) =>
        message.type === "remote_file_upload_url_request" &&
        message.fileName === "large-screenshot.webp",
    );
    expect(Number(upload?.size)).toBeLessThan(originalSize * 0.9);
  });
});
