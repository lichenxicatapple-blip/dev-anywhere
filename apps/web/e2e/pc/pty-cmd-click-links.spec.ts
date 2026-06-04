// PTY 模式下 cmd+click / ctrl+click 触发文件下载和图片预览的端到端验证。
//
// 真实点击需要 Playwright 把鼠标坐标精确投影到 xterm 字符 cell, 受字号 / 行高 / HiDPI
// 影响极不稳定。此处通过 src/test-hooks.ts 的 `__ccTest.pty.activateLink` 直接调
// link provider 的 provideLinks → activate, 验证 modifier gate 与下游协议消息正确,
// 但绕过坐标投影 — 真实坐标命中由人工 smoke 把关。

import { test, expect, type Page } from "@playwright/test";
import {
  gotoWithFakeProxy,
  installFakeRelay,
  sentFakeRelayMessages,
  type FakeRelayMessage,
} from "../helpers";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

async function emitPtyLine(page: Page, line: string): Promise<void> {
  await page.evaluate((data) => {
    window.__devAnywhereE2E?.socket?.emitPty("claude-pty", data);
  }, line);
}

async function waitForBufferContains(page: Page, needle: string): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        (n) => window.__ccTest?.pty.serialize("claude-pty").includes(n) ?? false,
        needle,
      ),
    )
    .toBe(true);
}

async function gotoPty(page: Page): Promise<void> {
  await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
  await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
  await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
}

type LinkKind = "image-preview" | "file-download";
type Modifier = "meta" | "ctrl" | "none";

async function activate(
  page: Page,
  kind: LinkKind,
  needle: string,
  modifier: Modifier,
): Promise<{ triggered: boolean; text?: string; lineNumber?: number } | undefined> {
  return page.evaluate(
    ({ kind: k, needle: n, modifier: m }) =>
      window.__ccTest?.pty.activateLink("claude-pty", k, n, m),
    { kind, needle, modifier },
  );
}

async function selectTerminalTextAndRelease(page: Page, text: string): Promise<void> {
  const selected = await page.evaluate((target) => {
    const term = window.__ccTestPtyTerminals?.get("claude-pty");
    const element = term?.element;
    const screen = element?.querySelector<HTMLElement>(".xterm-screen");
    if (!term || !element || !screen) return false;
    const buffer = term.buffer.active;
    const rect = screen.getBoundingClientRect();
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      const column = line.indexOf(target);
      if (column < 0) continue;
      term.select(column, row, target.length);
      const clientX = rect.left + (column + target.length) * cellWidth;
      const clientY = rect.top + (row - buffer.viewportY + 0.5) * cellHeight;
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerType: "mouse",
          button: 0,
          bubbles: true,
          clientX,
          clientY,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerType: "mouse",
          button: 0,
          bubbles: true,
          clientX,
          clientY,
        }),
      );
      return true;
    }
    return false;
  }, text);
  if (!selected) throw new Error(`could not select terminal text ${JSON.stringify(text)}`);
}

test.describe("PTY cmd/ctrl+click on file paths and image paths", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  // 仅断言协议消息不够: 中间还有 base64 → Blob → blob URL → <a download> → click 这段
  // 完全在浏览器里, 必须等 Playwright 的 download 事件并把文件读出来对比字节, 才能证明
  // 用户实际拿到了正确文件而不是 0 字节 / 错文件名 / blob URL revoked 抢跑。
  test("cmd+click triggers a real browser download with correct filename and bytes", async ({
    page,
  }) => {
    await gotoPty(page);
    const path = "./build/out.tar.gz";
    await emitPtyLine(page, `created ${path}\r\n`);
    await waitForBufferContains(page, path);

    const downloadPromise = page.waitForEvent("download");
    await activate(page, "file-download", path, "meta");
    const download = await downloadPromise;

    // fake relay file_download_response 固定回 dataBase64 "QUJD" -> bytes "ABC", filename 取 path 末段
    expect(download.suggestedFilename()).toBe("out.tar.gz");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("ABC");
  });

  test("ctrl+click on a file path also triggers download (non-mac users)", async ({ page }) => {
    await gotoPty(page);
    const path = "/var/log/system.log";
    await emitPtyLine(page, `tail ${path}\r\n`);
    await waitForBufferContains(page, path);

    await activate(page, "file-download", path, "ctrl");

    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent.some(
          (m: FakeRelayMessage) => m.type === "file_download_request" && m.path === path,
        );
      })
      .toBe(true);
  });

  test("plain click does not trigger file downloads or image previews", async ({ page }) => {
    await gotoPty(page);
    const filePath = "./README.md";
    const imagePath = ".dev-anywhere/clipboard/claude-pty/another.png";
    await emitPtyLine(page, `see ${filePath} and @${imagePath}\r\n`);
    await waitForBufferContains(page, filePath);
    await waitForBufferContains(page, imagePath);

    const result = await activate(page, "file-download", filePath, "none");
    // provider 仍然找到 link (triggered=true 表示 provideLinks 有命中并调用了 activate),
    // 但 activate 内部 modifier gate 早返回, 不会发协议消息。
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(filePath);
    await activate(page, "image-preview", imagePath, "none");

    await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeHidden();
    const sent = await sentFakeRelayMessages(page);
    expect(sent.some((m: FakeRelayMessage) => m.type === "file_download_request")).toBe(false);
    expect(sent.some((m: FakeRelayMessage) => m.type === "image_preview_request")).toBe(false);
  });

  test("cmd+click on an image path opens preview dialog and emits image_preview_request", async ({
    page,
  }) => {
    await gotoPty(page);
    const path = ".dev-anywhere/clipboard/claude-pty/shot.png";
    await emitPtyLine(page, `attached @${path}\r\n`);
    await waitForBufferContains(page, path);

    const result = await activate(page, "image-preview", path, "meta");
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(path);

    await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent.some(
          (m: FakeRelayMessage) =>
            m.type === "image_preview_request" && m.sessionId === "claude-pty" && m.path === path,
        );
      })
      .toBe(true);
  });

  test("selected image path opens preview from the terminal selection toolbar", async ({
    page,
  }) => {
    await gotoPty(page);
    await emitPtyLine(page, "artifact a=b.jpg ready\r\n");
    await waitForBufferContains(page, "a=b.jpg");

    await selectTerminalTextAndRelease(page, "b.jpg");

    const previewButton = page.getByRole("button", { name: "预览终端选区图片" });
    await expect(previewButton).toBeVisible();
    await previewButton.click();

    await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent.some(
          (m: FakeRelayMessage) =>
            m.type === "image_preview_request" &&
            m.sessionId === "claude-pty" &&
            m.path === "b.jpg",
        );
      })
      .toBe(true);
  });

  test("cmd+click on bare relative paths and top-level filenames triggers download", async ({
    page,
  }) => {
    await gotoPty(page);
    const paths = ["docs/superpowers/specs/2026-05-10-catos-mvk-tier1-acceptance.md", "README.md"];
    await emitPtyLine(page, `${paths[0]}: 验收说明\r\n${paths[1]}: 项目说明\r\n`);
    for (const path of paths) {
      await waitForBufferContains(page, path);

      const result = await activate(page, "file-download", path, "meta");
      expect(result?.triggered).toBe(true);
      expect(result?.text).toBe(path);

      await expect
        .poll(async () => {
          const sent = await sentFakeRelayMessages(page);
          return sent.some(
            (m: FakeRelayMessage) => m.type === "file_download_request" && m.path === path,
          );
        })
        .toBe(true);
    }
  });

  test("hover on any wrapped file path segment underlines every real segment", async ({ page }) => {
    await gotoPty(page);
    const cols = await page.evaluate(() => window.__ccTest?.pty.metrics("claude-pty")?.cols ?? 80);
    const repeated = Array.from(
      { length: Math.ceil((cols * 3) / 24) },
      () => "docs/superpowers/specs",
    ).join("/");
    const path = `/Users/catli/MyApps/AIMovieFactory/${repeated}/2026-05-25-v1-hover-overlay.md`;
    await emitPtyLine(page, `  - ${path}\r\n`);
    await waitForBufferContains(page, "hover-overlay.md");

    const result = await page.evaluate((expectedPath) => {
      const term = window.__ccTestPtyTerminals?.get("claude-pty");
      const provider = window.__ccTestPtyLinkProviders?.get("claude-pty/file-download");
      const element = term?.element;
      if (!term || !provider || !element) return null;

      for (let lineNumber = 1; lineNumber <= term.buffer.active.length; lineNumber += 1) {
        let matched = false;
        provider.provideLinks(lineNumber, (links) => {
          const link = links?.find((candidate) => candidate.text === expectedPath);
          if (!link) return;
          matched = true;
          link.hover?.(new MouseEvent("mousemove"), link.text);
        });
        if (!matched) continue;
        const segments = Array.from(
          element.querySelectorAll<HTMLElement>('[data-slot="pty-file-link-hover-segment"]'),
        ).map((segment) => ({
          range: segment.dataset.range,
          width: Number.parseFloat(segment.style.width),
        }));
        return {
          lineNumber,
          segments,
          rows: new Set(segments.map((segment) => segment.range?.split(":")[0])).size,
        };
      }
      return null;
    }, path);

    expect(result).not.toBeNull();
    expect(result?.segments.length ?? 0).toBeGreaterThan(1);
    expect(result?.rows ?? 0).toBeGreaterThan(1);
    expect(result?.segments.every((segment) => segment.width > 0)).toBe(true);
  });
});
