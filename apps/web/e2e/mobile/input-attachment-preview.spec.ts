import { expect, mobileBaseUrl, test } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";

test.describe("L4 mobile / chat attachment preview", () => {
  test.setTimeout(90_000);

  test("keeps file and image previews inside the composer and preserves the agent payload", async ({
    emuPage,
  }, testInfo) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("review ");
    await emuPage.locator('input[data-slot="input-attach-file-input"]').setInputFiles({
      name: "release-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("release notes"),
    });

    const card = emuPage.locator('[data-slot="input-file-attachment"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(emuPage.locator('[data-slot="input-attachment-name"]')).toHaveText(
      "release-notes.txt",
    );
    await expect(input).toHaveValue("review ");

    await input.evaluate(async (node) => {
      const response = await fetch("/pwa-512x512.png");
      if (!response.ok) throw new Error(`Image fixture request failed: ${response.status}`);
      const png = await response.blob();
      const file = new File([png], "design-preview.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    await expect(emuPage.locator('[data-slot="input-image-attachment"]')).toBeVisible();

    const layout = await emuPage.locator('[data-slot="input-card"]').evaluate((cardNode) => {
      const cardRect = cardNode.getBoundingClientRect();
      const attachmentRect = document
        .querySelector<HTMLElement>('[data-slot="input-file-attachment"]')
        ?.getBoundingClientRect();
      return {
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        attachmentLeft: attachmentRect?.left ?? -1,
        attachmentRight: attachmentRect?.right ?? -1,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.attachmentLeft).toBeGreaterThanOrEqual(layout.cardLeft);
    expect(layout.attachmentRight).toBeLessThanOrEqual(layout.cardRight);
    expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth);

    await testInfo.attach("attachment-preview", {
      body: await emuPage.screenshot(),
      contentType: "image/png",
    });

    await emuPage
      .locator('[data-slot="send-button"][data-variant="send"]')
      .evaluate((button: HTMLButtonElement) => button.click());
    const expectedFilePath = ".dev-anywhere/uploads/test-sess/uploaded-e2e.txt";
    const expectedImagePath = ".dev-anywhere/clipboard/test-sess/pasted-e2e.png";
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(emuPage)).find((message) => message.type === "user_input"),
      )
      .toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            text: `review @${expectedFilePath} @${expectedImagePath}`,
          }),
        }),
      );
  });

  test("scales portrait and landscape images without stretching the composer", async ({
    emuPage,
  }, testInfo) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("检查长图和宽图");
    const previews = emuPage.locator('[data-slot="input-image-attachment-preview"]');
    await pasteGeneratedImage(input, {
      name: "portrait.png",
      width: 96,
      height: 320,
      accent: "#16856f",
    });
    await expect(previews).toHaveCount(1);
    await pasteGeneratedImage(input, {
      name: "landscape.png",
      width: 320,
      height: 96,
      accent: "#a86f36",
    });

    await expect(previews).toHaveCount(2);
    const layout = await previews.evaluateAll((images) =>
      images.map((image) => {
        const imageRect = image.getBoundingClientRect();
        const cardRect = image
          .closest<HTMLElement>('[data-slot="input-card"]')
          ?.getBoundingClientRect();
        return {
          width: imageRect.width,
          height: imageRect.height,
          objectFit: getComputedStyle(image).objectFit,
          left: imageRect.left,
          right: imageRect.right,
          cardLeft: cardRect?.left ?? -1,
          cardRight: cardRect?.right ?? -1,
        };
      }),
    );
    for (const preview of layout) {
      expect(preview.width).toBe(preview.height);
      expect(preview.objectFit).toBe("contain");
      expect(preview.left).toBeGreaterThanOrEqual(preview.cardLeft);
      expect(preview.right).toBeLessThanOrEqual(preview.cardRight);
    }

    const screenshot = await emuPage.screenshot();
    await testInfo.attach("portrait-landscape-attachment-preview", {
      body: screenshot,
      contentType: "image/png",
    });
  });

  test("grows the composer for a file card and restores it after removal", async ({
    emuPage,
  }, testInfo) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("发送日志");
    const inputRegion = emuPage.locator('[data-slot="input-bar-region"]');
    const baseline = await measureComposerLayout(inputRegion);

    await emuPage.locator('input[data-slot="input-attach-file-input"]').setInputFiles({
      name: "debug-session.log",
      mimeType: "text/plain",
      buffer: Buffer.from("diagnostic output"),
    });
    const card = emuPage.locator('[data-slot="input-file-attachment"]');
    await expect(card).toBeVisible({ timeout: 15_000 });

    const expanded = await measureComposerLayout(inputRegion);
    expect(expanded.inputHeight).toBeGreaterThan(baseline.inputHeight);
    expect(expanded.inputTop).toBeLessThan(baseline.inputTop);
    expect(expanded.contentHeight).toBeLessThan(baseline.contentHeight);
    expect(expanded.contentBottom).toBeLessThanOrEqual(expanded.inputTop + 1);

    const screenshot = await emuPage.screenshot();
    await testInfo.attach("file-attachment-preview", {
      body: screenshot,
      contentType: "image/png",
    });

    await card
      .getByRole("button", { name: "移除附件 debug-session.log" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(card).toBeHidden();
    await expect
      .poll(async () => (await measureComposerLayout(inputRegion)).inputTop)
      .toBeCloseTo(baseline.inputTop, 0);
    await expect
      .poll(async () => (await measureComposerLayout(inputRegion)).inputHeight)
      .toBeCloseTo(baseline.inputHeight, 0);
    await expect
      .poll(async () => (await measureComposerLayout(inputRegion)).contentHeight)
      .toBeCloseTo(baseline.contentHeight, 0);
  });

  test("keeps many image previews on one horizontally scrollable row", async ({
    emuPage,
  }, testInfo) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("检查多图");
    const previews = emuPage.locator('[data-slot="input-image-attachment-preview"]');
    const images = [
      { name: "one.png", width: 160, height: 160, accent: "#16856f" },
      { name: "two.png", width: 240, height: 120, accent: "#a86f36" },
      { name: "three.png", width: 120, height: 240, accent: "#3b6ea8" },
      { name: "four.png", width: 180, height: 120, accent: "#8c5f9d" },
      { name: "five.png", width: 120, height: 180, accent: "#b04c5b" },
      { name: "six.png", width: 220, height: 120, accent: "#4c7a3d" },
    ];

    await pasteGeneratedImage(input, images[0]);
    await expect(previews).toHaveCount(1);
    const strip = emuPage.locator('[data-slot="input-attachments"]');
    const singleRowHeight = await strip.evaluate((element) => element.clientHeight);

    for (const image of images.slice(1)) {
      await pasteGeneratedImage(input, image);
      await expect(previews).toHaveCount(images.indexOf(image) + 1);
    }

    const overflow = await strip.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(overflow.clientHeight).toBe(singleRowHeight);
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    expect(overflow.scrollHeight).toBe(overflow.clientHeight);

    await testInfo.attach("many-image-attachment-preview", {
      body: await emuPage.screenshot(),
      contentType: "image/png",
    });

    const finalScrollLeft = await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(finalScrollLeft).toBeGreaterThan(0);
    await expect(previews.last()).toBeInViewport();
  });
});

async function pasteGeneratedImage(
  input: import("@playwright/test").Locator,
  image: { name: string; width: number; height: number; accent: string },
): Promise<void> {
  await input.evaluate(async (node, options) => {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = options.accent;
    context.fillRect(0, 0, canvas.width, canvas.height * 0.45);
    context.fillStyle = "#202124";
    context.fillRect(
      canvas.width * 0.12,
      canvas.height * 0.58,
      canvas.width * 0.62,
      Math.max(6, canvas.height * 0.08),
    );
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed")))),
    );
    const file = new File([png], options.name, { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, image);
}

async function measureComposerLayout(inputRegion: import("@playwright/test").Locator) {
  return inputRegion.evaluate((region) => {
    const inputRect = region.getBoundingClientRect();
    const contentRect = region.previousElementSibling?.getBoundingClientRect();
    if (!contentRect) throw new Error("Chat content region not found");
    return {
      inputTop: inputRect.top,
      inputHeight: inputRect.height,
      contentBottom: contentRect.bottom,
      contentHeight: contentRect.height,
    };
  });
}
