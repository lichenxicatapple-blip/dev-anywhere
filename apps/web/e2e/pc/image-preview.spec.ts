import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

async function openJsonPreview(page: Page, path: string): Promise<void> {
  const input = page.getByLabel("输入聊天消息");
  await input.fill(`inspect @${path}`);
  await page.locator('[data-slot="send-button"][data-variant="send"]').click();
  await page.locator('[data-slot="inline-image-preview-link"]', { hasText: path }).click();
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

async function waitForTransformToSettle(transform: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        transform.evaluate(
          (el) =>
            new Promise<boolean>((resolve) => {
              const samples: string[] = [];
              const sample = () => {
                samples.push(getComputedStyle(el).transform);
                if (samples.length < 5) {
                  requestAnimationFrame(sample);
                  return;
                }
                resolve(new Set(samples).size === 1);
              };
              requestAnimationFrame(sample);
            }),
        ),
      { timeout: 2_000 },
    )
    .toBe(true);
}

async function dragUntilTransformChanges(
  page: Page,
  transform: Locator,
  startTransform: string,
  x: number,
  y: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 60, y + 60, { steps: 10 });
        await page.mouse.up();
        return transform.evaluate((el) => getComputedStyle(el).transform);
      },
      { timeout: 2_000 },
    )
    .not.toBe(startTransform);
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
      await page.locator('[data-slot="inline-image-preview-link"]', { hasText: path }).click();
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

    test("wheel zooms, mouse drag pans, and double-click resets transform", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/zoom.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      // react-zoom-pan-pinch 把 transform 应用在 .react-transform-component 上 (inline style),
      // 通过 getComputedStyle 读 matrix(...) 字符串验证缩放/平移生效。
      const transform = page.locator(
        '[data-slot="image-preview-stage"] .react-transform-component',
      );
      const stage = page.locator('[data-slot="image-preview-stage"]');
      const stageBox = await stage.boundingBox();
      expect(stageBox).not.toBeNull();
      const cx = stageBox!.x + stageBox!.width / 2;
      const cy = stageBox!.y + stageBox!.height / 2;

      // hover 在中心后 wheel up, 让 scale 走出 1 (cursor-anchored 缩放)。
      // 不打到 max scale, 否则后续拖拽可能落在边界上不改变 transform。
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -20);
      await expect
        .poll(() => transform.evaluate((el) => getComputedStyle(el).transform))
        .not.toMatch(/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/);
      await waitForTransformToSettle(transform);
      const beforePan = await transform.evaluate((el) => getComputedStyle(el).transform);

      await dragUntilTransformChanges(page, transform, beforePan, cx, cy);

      // 双击 reset 回 fit: lib 的 dblclick listener 用原生 addEventListener 挂在
      // .react-transform-wrapper 上, target 必须是 wrapper 的后代; 直接对 component
      // dispatchEvent 走 bubble 路径, 跟真双击等价但不受 hit testing / stage clip 影响。
      await page.evaluate(
        ({ x, y }) => {
          const component = document.querySelector<HTMLElement>(".react-transform-component");
          if (!component) throw new Error("react-transform-component not found");
          component.dispatchEvent(
            new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
          );
        },
        { x: cx, y: cy },
      );
      await expect
        .poll(() => transform.evaluate((el) => getComputedStyle(el).transform))
        .toMatch(/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/);
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

    test("two-finger pinch increases scale; double-tap dispatch resets", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/pinch.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      const transform = page.locator(
        '[data-slot="image-preview-stage"] .react-transform-component',
      );
      const stage = page.locator('[data-slot="image-preview-stage"]');
      const stageBox = await stage.boundingBox();
      expect(stageBox).not.toBeNull();
      const cx = stageBox!.x + stageBox!.width / 2;
      const cy = stageBox!.y + stageBox!.height / 2;

      // Playwright touchscreen 只支持单指 tap; 两指 pinch 走 CDP Input.dispatchTouchEvent。
      // 两指从中心向两侧滑开几步, 模拟"捏开"; lib 的 onTouchPanning 在 touches.length===2
      // 时进入 pinch 分支, 算两指距离变化转 scale。
      const cdp = await page.context().newCDPSession(page);
      const points = (offset: number) => [
        { x: cx - offset, y: cy, id: 1 },
        { x: cx + offset, y: cy, id: 2 },
      ];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(20) });
      for (const offset of [40, 80, 120, 160, 200]) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: points(offset),
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

      await expect
        .poll(() => transform.evaluate((el) => getComputedStyle(el).transform))
        .not.toMatch(/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/);
      await waitForTransformToSettle(transform);

      // 双击 reset 复用桌面同思路, 直接 dispatch dblclick 不依赖 hit testing。
      await page.evaluate(
        ({ x, y }) => {
          const component = document.querySelector<HTMLElement>(".react-transform-component");
          if (!component) throw new Error("react-transform-component not found");
          component.dispatchEvent(
            new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
          );
        },
        { x: cx, y: cy },
      );
      await expect
        .poll(() => transform.evaluate((el) => getComputedStyle(el).transform))
        .toMatch(/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/);
    });

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
