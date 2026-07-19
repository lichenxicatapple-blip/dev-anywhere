// 验证媒体 / 文件 input 拆分：媒体入口接受照片和视频；通用文件入口按平台策略过滤，
// 桌面和 Safari 接受所有类型，Android 则避免触发部分浏览器的相机权限请求。
//
// 这里只验静态 DOM 契约 (菜单两项 + hidden input accept 属性), 不真触发文件选择器。
import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

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
  });
});
