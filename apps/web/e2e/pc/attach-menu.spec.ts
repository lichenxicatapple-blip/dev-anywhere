// 验证图片 / 文件 input 拆分: vivo Chrome 等 OEM 定制在点击没设 accept 的 file input
// 时会预申请相机权限。"上传文件" 路径 accept 排除 image/video → 不再触发相机弹窗;
// "上传图片" 路径 accept="image/*" → 显式选图意图, 即使弹相机也符合预期。
//
// 这里只验静态 DOM 契约 (菜单两项 + hidden input accept 属性), 不真触发文件选择器。
import { test, expect } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

test.describe("attach menu — image vs file accept split", () => {
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
    await expect(imageInput).toHaveAttribute("accept", "image/*");
    await expect(fileInput).toHaveAttribute("accept", "application/*,text/*");
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
    await expect(imageInput).toHaveAttribute("accept", "image/*");
    await expect(fileInput).toHaveAttribute("accept", "application/*,text/*");
    await expect(imageInput).toHaveAttribute("type", "file");
    await expect(fileInput).toHaveAttribute("type", "file");
  });

  test("JSON 模式 mobile 视口 paperclip 改弹 Sheet, 仍露两项", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    await page.locator('[data-slot="input-attach-button"]').click();

    // Sheet 跟 Popover 共用 input-attach-menu data-slot, 这里只验菜单可见 +
    // 两项可点 (具体 Popover vs Sheet 容器形态由 useMediaQuery 决定, 不再断言).
    await expect(page.locator('[data-slot="input-attach-menu"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-attach-menu-image"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-attach-menu-file"]')).toBeVisible();
  });
});
