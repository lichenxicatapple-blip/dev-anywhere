import { test, expect, type Locator } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

const pngBytes = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239,
  191, 167, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

async function dispatchImagePaste(target: Locator): Promise<void> {
  await target.evaluate((node, bytes) => {
    const file = new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    node.dispatchEvent(event);
  }, pngBytes);
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

  test("JSON mode previews pasted images and sends the original file token", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("inspect ");
    await dispatchImagePaste(input);

    const expectedPath = ".dev-anywhere/clipboard/test-sess/pasted-e2e.png";
    await expect(page.locator('[data-slot="input-image-attachment"]')).toBeVisible();
    const preview = page.getByRole("img", { name: "shot.png" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((image: HTMLImageElement) => ({
          width: image.naturalWidth,
          height: image.naturalHeight,
        })),
      )
      .toEqual({ width: 1, height: 1 });
    await expect(input).toHaveValue("inspect ");
    await expect(input).not.toHaveValue(new RegExp(expectedPath));

    let sent = await sentFakeRelayMessages(page);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "remote_file_upload_url_request",
        sessionId: "test-sess",
        kind: "clipboard_image",
        mimeType: "image/png",
        fileName: "shot.png",
        size: pngBytes.length,
      }),
    );
    expect(sent.some((msg) => msg.type === "user_input")).toBe(false);

    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(async () => {
        sent = await sentFakeRelayMessages(page);
        return sent.find((message) => message.type === "user_input");
      })
      .toEqual(
        expect.objectContaining({
          sessionId: "test-sess",
          payload: expect.objectContaining({
            text: `inspect @${expectedPath}`,
          }),
        }),
      );
    await expect(page.locator('[data-slot="input-attachments"]')).toHaveCount(0);
  });

  test("PTY mode uploads pasted images and sends the returned file token as raw input", async ({
    page,
  }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
      "data-connection-ready",
      "true",
    );

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
        size: pngBytes.length,
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
