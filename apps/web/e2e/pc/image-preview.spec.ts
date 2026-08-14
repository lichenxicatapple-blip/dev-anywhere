import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

async function openJsonPreview(page: Page, path: string): Promise<void> {
  const input = page.getByLabel("输入聊天消息");
  await input.fill(`inspect @${path}`);
  await page.locator('[data-slot="send-button"][data-variant="send"]').click();
  const thumbnail = page.locator('[data-slot="user-image-attachment"]');
  await expect(thumbnail).toBeVisible();
  const thumbnailBox = await thumbnail.boundingBox();
  expect(thumbnailBox?.width).toBeLessThanOrEqual(129);
  await thumbnail.click();
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
      type: "remote_file_url_request",
      sessionId: expect.any(String),
      path,
      disposition: "inline",
    }),
  );
}

async function closePreview(page: Page): Promise<void> {
  await page.locator('[data-slot="image-preview-dialog"] [data-slot="dialog-close"]').click();
  await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeHidden();
}

async function setWideImagePreviewData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 320;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = "#111827";
    ctx.font = "64px sans-serif";
    ctx.fillText("wide preview fixture", 64, 190);
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    if (!base64) throw new Error("canvas export failed");
    window.__devAnywhereE2E?.setImagePreviewDataBase64(base64);
  });
}

async function expectInside(outer: Locator, inner: Locator, label: string): Promise<void> {
  const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(outerBox, `${label} outer box`).not.toBeNull();
  expect(innerBox, `${label} inner box`).not.toBeNull();
  expect(innerBox!.x, `${label} left`).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y, `${label} top`).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width, `${label} right`).toBeLessThanOrEqual(
    outerBox!.x + outerBox!.width + 1,
  );
  expect(innerBox!.y + innerBox!.height, `${label} bottom`).toBeLessThanOrEqual(
    outerBox!.y + outerBox!.height + 1,
  );
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

async function getTransformScale(transform: Locator): Promise<number> {
  return transform.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
}

async function resolvePtyImageLinkRange(
  page: Page,
  sessionId: string,
  path: string,
): Promise<{
  cols: number;
  linkStartColumn: number;
  linkEndColumn: number;
}> {
  type LinkRange = { cols: number; linkStartColumn: number; linkEndColumn: number };
  let resolvedRange: LinkRange | null = null;
  await expect
    .poll(async () => {
      resolvedRange = await page.evaluate(
        ({ sid, targetPath }) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          const provider = window.__ccTestPtyLinkProviders?.get(`${sid}/image-preview`);
          if (!term || !provider || term.cols <= 0) return null;
          const buffer = term.buffer.active;
          for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
            if (!buffer.getLine(row)?.translateToString(true).includes(targetPath)) continue;
            let match: { start: number; end: number } | null = null;
            provider.provideLinks(row + 1, (links) => {
              const link = links?.find((candidate) => candidate.text === targetPath);
              if (!link || link.range.start.y !== row + 1 || link.range.end.y !== row + 1) return;
              match = { start: link.range.start.x, end: link.range.end.x };
            });
            if (match) {
              return {
                cols: term.cols,
                linkStartColumn: match.start,
                linkEndColumn: match.end,
              };
            }
          }
          return null;
        },
        { sid: sessionId, targetPath: path },
      );
      return resolvedRange !== null;
    })
    .toBe(true);
  if (!resolvedRange) throw new Error(`image link provider did not expose ${JSON.stringify(path)}`);
  return resolvedRange;
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
      await page.evaluate(() => window.__devAnywhereE2E?.holdImagePreviews());

      await openJsonPreview(page, path);
      await expect(page.locator('[data-slot="image-preview-loading"]')).toBeVisible();
      await expect(page.locator('[data-slot="image-preview-loading"]')).toContainText(
        "正在从开发机读取图片",
      );
      await expect(page.locator('[data-slot="image-preview-copy-image"]')).toBeDisabled();
      await page.evaluate(() => window.__devAnywhereE2E?.releaseImagePreviews());
      await expectPreviewReady(page, path);
      await expect(page.locator('[data-slot="image-preview-copy-image"]')).toBeEnabled();

      await closePreview(page);
      await page.locator('[data-slot="user-image-attachment"]').click();
      await expectPreviewReady(page, path);
    });

    test("keeps long image paths and footer actions inside the desktop dialog", async ({
      page,
    }) => {
      const path =
        "/Users/catli/MyApps/dev-anywhere/.dev-anywhere/clipboard/test-sess/a-very-long-directory-name/another-very-long-directory-name/third-very-long-directory-name/fourth-very-long-directory-name/fifth-very-long-directory-name/paste-ZLC5zm.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await page.evaluate(() => window.__devAnywhereE2E?.holdImagePreviews());

      await openJsonPreview(page, path);

      const dialog = page.locator('[data-slot="image-preview-dialog"]');
      await expect(dialog).toBeVisible();
      await expect(page.locator('[data-slot="image-preview-loading"]')).toContainText(
        "正在从开发机读取图片",
      );
      await expect(page.locator('[data-slot="image-preview-meta"]')).toHaveText(
        "正在从开发机读取图片...",
      );

      await expectInside(dialog, page.locator('[data-slot="image-preview-stage"]'), "stage");
      await expectInside(dialog, page.locator('[data-slot="image-preview-footer"]'), "footer");
      await expectInside(
        dialog,
        page.locator('[data-slot="image-preview-download"]'),
        "download button",
      );
      await expectInside(
        dialog,
        page.locator('[data-slot="image-preview-copy-image"]'),
        "copy image button",
      );
      await expectInside(
        dialog,
        page.locator('[data-slot="image-preview-copy-path"]'),
        "copy path button",
      );

      await page.evaluate(() => window.__devAnywhereE2E?.releaseImagePreviews());
      await expectPreviewReady(page, path);
      await expect(page.locator('[data-slot="image-preview-meta"]')).toHaveText("图片已加载");
    });

    test("writes the loaded image itself to the image Clipboard API", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/copy-image.png";
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            write: async (items: ClipboardItem[]) => {
              await Promise.all(
                items.flatMap((item) => item.types.map((type) => item.getType(type))),
              );
              Object.defineProperty(window, "__copiedImageTypes", {
                configurable: true,
                value: items.flatMap((item) => item.types),
              });
            },
          },
        });
      });
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      await page.locator('[data-slot="image-preview-copy-image"]').click();

      await expect(page.getByText("图片已复制到剪贴板")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { __copiedImageTypes?: string[] }).__copiedImageTypes ??
              [],
          ),
        )
        .toContain("image/png");
    });

    test("shows an explicit error when the browser cannot decode the image", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/broken.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await page.evaluate(() => window.__devAnywhereE2E?.setImagePreviewDataBase64("AQID"));

      await openJsonPreview(page, path);

      await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
      await expect(page.locator('[data-slot="image-preview-error"]')).toContainText(
        "浏览器无法读取或解码这张图片",
      );
      await expect(page.locator('[data-slot="image-preview-loading"]')).toBeHidden();
    });

    test("wheel zooms, mouse drag pans, and double-click resets transform", async ({ page }) => {
      const path = ".dev-anywhere/clipboard/test-sess/zoom.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await setWideImagePreviewData(page);
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
      const initialScale = await getTransformScale(transform);

      // hover 在中心后 wheel up, 让 scale 走出初始 fit scale (cursor-anchored 缩放)。
      // 不打到 max scale, 否则后续拖拽可能落在边界上不改变 transform。
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await expect.poll(() => getTransformScale(transform)).toBeGreaterThan(initialScale);
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
      await expect.poll(() => getTransformScale(transform)).toBeCloseTo(initialScale, 3);
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

      // "$ " 占 2 格，13 个 CJK 字符/标点占 26 格，空格占 1 格，所以 provider
      // 刻意纳入 link range 的 @ 必须从 1-based 第 30 列开始；第 33 列落在路径内部。
      const expectedLinkStartColumn = 30;
      const linkColumn = 33;
      const range = await resolvePtyImageLinkRange(page, "claude-pty", path);
      expect(range.linkStartColumn).toBe(expectedLinkStartColumn);
      expect(range.linkEndColumn).toBeGreaterThanOrEqual(linkColumn);

      const screen = page.locator('[data-slot="pty-host"] .xterm-screen');
      const renderedRow = screen.locator(":scope > .xterm-rows > div").filter({ hasText: path });
      await expect(renderedRow).toHaveCount(1);
      const rowBox = await renderedRow.boundingBox();
      if (!rowBox) throw new Error("rendered image link row has no geometry");
      const position = {
        x: ((linkColumn - 0.5) * rowBox.width) / range.cols,
        y: rowBox.height / 2,
      };
      // xterm rows intentionally ignore pointer events. A forced locator-relative action still
      // resolves the live row box at action time while the browser hit-tests the xterm screen.
      await renderedRow.hover({ position, force: true });
      await expect(screen).toHaveClass(/xterm-cursor-pointer/);
      await renderedRow.click({ position, modifiers: ["Meta"], force: true });

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
      const initialScale = await getTransformScale(transform);

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

      await expect.poll(() => getTransformScale(transform)).toBeGreaterThan(initialScale);
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
      await expect.poll(() => getTransformScale(transform)).toBeCloseTo(initialScale, 3);
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

    test("keeps all image actions above the mobile bottom edge without covering the preview", async ({
      page,
    }) => {
      const path = "./screenshots/mobile-actions.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      const dialog = page.locator('[data-slot="image-preview-dialog"]');
      const stage = page.locator('[data-slot="image-preview-stage"]');
      const footer = page.locator('[data-slot="image-preview-footer"]');
      const actionSlots = [
        "image-preview-download",
        "image-preview-copy-image",
        "image-preview-copy-path",
      ];
      const [dialogBox, stageBox, footerBox] = await Promise.all([
        dialog.boundingBox(),
        stage.boundingBox(),
        footer.boundingBox(),
      ]);
      expect(dialogBox).not.toBeNull();
      expect(stageBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect(
        dialogBox!.y + dialogBox!.height - (footerBox!.y + footerBox!.height),
      ).toBeGreaterThanOrEqual(20);
      expect(stageBox!.y + stageBox!.height).toBeLessThanOrEqual(footerBox!.y);

      const widths: number[] = [];
      for (const slot of actionSlots) {
        const button = page.locator(`[data-slot="${slot}"]`);
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        widths.push(box!.width);
        expect(box!.x).toBeGreaterThanOrEqual(dialogBox!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
      }
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });

    test("fits a very wide image inside the mobile viewport on first render", async ({ page }) => {
      const path = "./screenshots/wide-mobile-preview.png";
      await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
      await setWideImagePreviewData(page);

      await openJsonPreview(page, path);
      await expectPreviewReady(page, path);

      const stageBox = await page.locator('[data-slot="image-preview-stage"]').boundingBox();
      expect(stageBox).not.toBeNull();
      const naturalWidth = await page
        .locator('[data-slot="image-preview-img"]')
        .evaluate((el) => (el as HTMLImageElement).naturalWidth);
      expect(naturalWidth).toBeGreaterThan(stageBox!.width * 2);
      await expect
        .poll(() =>
          page
            .locator('[data-slot="image-preview-stage"] .react-transform-component')
            .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a),
        )
        .toBeLessThan(1);
      const transformBox = await page
        .locator('[data-slot="image-preview-stage"] .react-transform-component')
        .boundingBox();
      const imgBox = await page.locator('[data-slot="image-preview-img"]').boundingBox();
      expect(transformBox).not.toBeNull();
      expect(imgBox).not.toBeNull();
      expect(transformBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1);
      expect(transformBox!.x + transformBox!.width).toBeLessThanOrEqual(
        stageBox!.x + stageBox!.width + 1,
      );
      expect(imgBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1);
      expect(imgBox!.x + imgBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1);
    });
  });
});
