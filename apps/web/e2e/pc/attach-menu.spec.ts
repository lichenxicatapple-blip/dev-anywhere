// 验证媒体 / 文件 input 拆分：媒体入口接受照片和视频；通用文件入口按平台策略过滤，
// 桌面和 Safari 接受所有类型，Android 则避免触发部分浏览器的相机权限请求。
//
// 浏览器文件输入验证多选、附件预览和最终发给 Agent 的路径；上传 HTTP 由 fake relay 接管。
import { test, expect, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

interface UploadFixture {
  name: string;
  mimeType: string;
  buffer: Buffer;
  path: string;
}

// 共享 fake relay 默认返回同一文件路径；本 spec 按实际收到的文件内容返回不同路径，
// 这样漏传、重复上传或把多个附件拼错顺序都会被最终消息断言发现。
async function useDistinctUploadPaths(page: Page, files: UploadFixture[]): Promise<string[]> {
  const uploadedNames: string[] = [];
  await page.route("**/api/remote-uploads/*", async (route) => {
    const body = route.request().postDataBuffer();
    const file = files.find((candidate) => body?.equals(candidate.buffer));
    expect(file, "上传请求应包含所选文件的完整内容").toBeDefined();
    if (!file) return;
    uploadedNames.push(file.name);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: new URL(route.request().url()).searchParams.get("sessionId"),
        success: true,
        path: file.path,
      }),
    });
  });
  return uploadedNames;
}

test.describe("attach menu — media vs file accept split", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("PTY 模式 chat header 菜单两项, hidden input accept 各自隔离", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(page.locator('[data-slot="chat-menu-upload-image"]')).toBeVisible();
    await expect(page.locator('[data-slot="chat-menu-upload-file"]')).toBeVisible();

    // hidden input 不在 visible tree 里, 用 attached + getAttribute 直接断言
    const imageInput = page.locator('input[data-slot="chat-menu-upload-image-input"]');
    const fileInput = page.locator('input[data-slot="chat-menu-upload-file-input"]');
    await expect(page.locator('[data-slot="chat-menu-upload-image"]')).toContainText(
      "上传照片或视频",
    );
    await expect(imageInput).toHaveAttribute("accept", "image/*,video/*");
    await expect(fileInput).not.toHaveAttribute("accept");
    await expect(imageInput).toHaveAttribute("type", "file");
    await expect(fileInput).toHaveAttribute("type", "file");
    await expect(imageInput).toHaveAttribute("multiple", "");
    await expect(fileInput).toHaveAttribute("multiple", "");
  });

  test("JSON 模式 desktop paperclip 弹 Popover, 两菜单项 + hidden input accept 隔离", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const attachButton = page.locator('[data-slot="input-attach-button"]');
    await expect(attachButton).toBeVisible();
    await attachButton.click();

    await expect(page.locator('[data-slot="input-attach-menu"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-attach-menu-image"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-attach-menu-file"]')).toBeVisible();

    const imageInput = page.locator('input[data-slot="input-attach-image-input"]');
    const fileInput = page.locator('input[data-slot="input-attach-file-input"]');
    await expect(page.locator('[data-slot="input-attach-menu-image"]')).toContainText(
      "上传照片或视频",
    );
    await expect(imageInput).toHaveAttribute("accept", "image/*,video/*");
    await expect(fileInput).not.toHaveAttribute("accept");
    await expect(imageInput).toHaveAttribute("type", "file");
    await expect(fileInput).toHaveAttribute("type", "file");
    await expect(imageInput).toHaveAttribute("multiple", "");
    await expect(fileInput).toHaveAttribute("multiple", "");
  });

  test("JSON 模式把上传文件显示为卡片, 发送时仍使用 @<path>", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("review ");
    await page.locator('input[data-slot="input-attach-file-input"]').setInputFiles({
      name: "release-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("release notes"),
    });

    const expectedPath = ".dev-anywhere/uploads/test-sess/uploaded-e2e.txt";
    await expect(page.locator('[data-slot="input-file-attachment"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-attachment-name"]')).toHaveText(
      "release-notes.txt",
    );
    await expect(input).toHaveValue("review ");
    await expect(input).not.toHaveValue(new RegExp(expectedPath));

    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page)).find((message) => message.type === "user_input"),
      )
      .toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            text: `review @${expectedPath}`,
          }),
        }),
      );
  });

  test("JSON 同时选择图片和文件后全部预览，并按选择顺序发送", async ({ page }) => {
    const files: UploadFixture[] = [
      {
        name: "screenshot.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          "base64",
        ),
        path: ".dev-anywhere/uploads/test-sess/screenshot.png",
      },
      {
        name: "release-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("first document: release notes"),
        path: ".dev-anywhere/uploads/test-sess/release-notes.txt",
      },
      {
        name: "checklist.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("second document: release checklist"),
        path: ".dev-anywhere/uploads/test-sess/checklist.md",
      },
    ];
    const uploadedNames = await useDistinctUploadPaths(page, files);
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("review these");
    await page.locator('input[data-slot="input-attach-file-input"]').setInputFiles(files);

    await expect(page.locator('[data-slot="input-image-attachment"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="input-file-attachment"]')).toHaveCount(2);
    await expect(page.locator('[data-slot="input-attachment-name"]')).toHaveText([
      "release-notes.txt",
      "checklist.md",
    ]);
    await expect(page.getByRole("img", { name: "screenshot.png", exact: true })).toBeVisible();
    await expect(input).toHaveValue("review these");
    expect(uploadedNames).toEqual(files.map((file) => file.name));

    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page))
          .filter((message) => message.type === "user_input")
          .map((message) => message.payload),
      )
      .toEqual([
        expect.objectContaining({
          text: `review these ${files.map((file) => `@${file.path}`).join(" ")}`,
        }),
      ]);
    await expect(page.locator('[data-slot="input-attachments"]')).toHaveCount(0);
  });

  test("PTY 同时选择多个文件后，只插入一次包含全部路径的输入", async ({ page }) => {
    const files: UploadFixture[] = [
      {
        name: "first.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("first PTY attachment"),
        path: ".dev-anywhere/uploads/claude-pty/first.txt",
      },
      {
        name: "second.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("second PTY attachment"),
        path: ".dev-anywhere/uploads/claude-pty/second.md",
      },
    ];
    const uploadedNames = await useDistinctUploadPaths(page, files);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await page.locator('input[data-slot="chat-menu-upload-file-input"]').setInputFiles(files);

    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page))
          .filter(
            (message) =>
              message.type === "remote_input_raw" &&
              String(message.data).includes(".dev-anywhere/uploads/"),
          )
          .map((message) => ({ sessionId: message.sessionId, data: message.data })),
      )
      .toEqual([
        {
          sessionId: "claude-pty",
          data: files.map((file) => `@${file.path} `).join(""),
        },
      ]);
    expect(uploadedNames).toEqual(files.map((file) => file.name));
  });

  test.describe("mobile browser layout", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    });

    test("一次多选六张图片后，预览保持单行横向滚动，输入区不超出屏幕", async ({
      page,
    }, testInfo) => {
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      const files = Array.from({ length: 6 }, (_, index) => ({
        name: `photo-${index + 1}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          "base64",
        ),
      }));
      await page.locator('input[data-slot="input-attach-image-input"]').setInputFiles(files);

      const previews = page.locator('[data-slot="input-image-attachment"]');
      await expect(previews).toHaveCount(files.length);
      const strip = page.locator('[data-slot="input-attachments"]');
      const layout = await strip.evaluate((element) => {
        const card = element.closest('[data-slot="input-card"]')!;
        const cardRect = card.getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          imageTops: Array.from(element.children, (child) => child.getBoundingClientRect().top),
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          viewportWidth: window.innerWidth,
        };
      });
      expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
      expect(layout.scrollHeight).toBe(layout.clientHeight);
      expect(new Set(layout.imageTops).size).toBe(1);
      expect(layout.cardLeft).toBeGreaterThanOrEqual(0);
      expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth);

      await strip.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(previews.last()).toBeInViewport();
      await page.getByRole("button", { name: "移除附件 photo-6.png", exact: true }).click();
      await expect(previews).toHaveCount(files.length - 1);
      await testInfo.attach("mobile-batch-image-previews", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
});
