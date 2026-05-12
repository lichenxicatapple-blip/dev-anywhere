import { test, expect, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

async function openJsonPreview(page: Page, path: string): Promise<void> {
  const input = page.getByLabel("输入聊天消息");
  await input.fill(`inspect @${path}`);
  await page.locator('[data-slot="send-button"][data-variant="send"]').click();
  await page.locator('[data-slot="image-preview-link"]', { hasText: path }).click();
}

async function expectPreviewReady(page: Page, path: string): Promise<void> {
  await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
  await expect(page.locator('[data-slot="image-preview-stage"]')).toBeVisible();
  await expect(page.locator('[data-slot="image-preview-img"]')).toHaveAttribute(
    "data-loaded",
    "true",
  );

  const sent = await sentFakeRelayMessages(page);
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "image_preview_request",
      sessionId: expect.any(String),
      path,
    }),
  );
}

async function closePreview(page: Page): Promise<void> {
  await page.locator('[data-slot="image-preview-dialog"] [data-slot="dialog-close"]').click();
  await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeHidden();
}

test.describe("image preview", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

    test("JSON mode opens local image paths with a loading transition", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/preview.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await page.evaluate(() => window.__devAnywhereE2E?.setImagePreviewDelay(250));

      await openJsonPreview(page, path);
      await expect(page.locator('[data-slot="image-preview-loading"]')).toBeVisible();
      await expect(page.locator('[data-slot="image-preview-loading"]')).toContainText(
        "正在从开发机读取图片",
      );
      await expectPreviewReady(page, path);

      await closePreview(page);
      await page.locator('[data-slot="image-preview-link"]', { hasText: path }).click();
      await expectPreviewReady(page, path);
    });

    test("shows an explicit error when the browser cannot decode the image", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/broken.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await page.evaluate(() => window.__devAnywhereE2E?.setImagePreviewDataBase64("AQID"));

      await openJsonPreview(page, path);

      await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
      await expect(page.locator('[data-slot="image-preview-error"]')).toContainText(
        "浏览器无法解码这张图片",
      );
      await expect(page.locator('[data-slot="image-preview-loading"]')).toBeHidden();
    });

    test("PTY mode links image paths from terminal output after CJK text", async ({ page }) => {
      const path = ".dev-anywhere/preview-demo.png";
      await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
      await expect(page.locator('[data-slot="pty-host"] .xterm-screen')).toBeVisible();

      await page.evaluate((imagePath) => {
        window.__devAnywhereE2E?.socket?.emitPty(
          "claude-pty",
          `可测路径，应该能直接点击： @${imagePath}\r\n`,
        );
      }, path);
      await expect
        .poll(() => page.evaluate(() => window.__ccTest?.pty.serialize("claude-pty") ?? ""))
        .toContain(path);

      const point = await page.evaluate(() => {
        const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
        const metrics = window.__ccTest?.pty.metrics("claude-pty");
        if (!screen || !metrics) return null;
        const rect = screen.getBoundingClientRect();
        const cellWidth = metrics.screenWidth / metrics.cols;
        const cellHeight = metrics.screenHeight / metrics.rows;
        const linkColumn = 33;
        return {
          x: rect.left + cellWidth * (linkColumn - 0.5),
          y: rect.top + cellHeight * 1.5,
        };
      });
      expect(point).not.toBeNull();
      await page.mouse.move(point!.x, point!.y);
      // link provider 的 activate gate 要求 cmd/ctrl 修饰: 普通 click 不触发预览,
      // 通过 keyboard.down("Meta") 在 click 期间持有修饰键。
      await page.keyboard.down("Meta");
      await page.mouse.click(point!.x, point!.y);
      await page.keyboard.up("Meta");

      await expectPreviewReady(page, path);
    });
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("uses the full viewport instead of a cramped modal", async ({ page }) => {
      const path = "./screenshots/mobile-preview.jpg";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      const box = await page.locator('[data-slot="image-preview-dialog"]').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeLessThanOrEqual(1);
      expect(box!.y).toBeLessThanOrEqual(1);
      expect(box!.width).toBeGreaterThanOrEqual(388);
      expect(box!.height).toBeGreaterThanOrEqual(840);
    });
  });
});
