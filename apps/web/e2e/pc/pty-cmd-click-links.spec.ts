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

test.describe("PTY cmd/ctrl+click on file paths and image paths", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
  });

  test("cmd+click on a file path triggers file_download_request with that path", async ({
    page,
  }) => {
    await gotoPty(page);
    const path = "./build/out.tar.gz";
    await emitPtyLine(page, `created ${path}\r\n`);
    await waitForBufferContains(page, path);

    const result = await activate(page, "file-download", path, "meta");
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(path);

    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return sent.find(
          (m: FakeRelayMessage) =>
            m.type === "file_download_request" && m.sessionId === "claude-pty" && m.path === path,
        );
      })
      .toBeDefined();
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

  test("plain click on a file path does NOT trigger download (anti-misclick gate)", async ({
    page,
  }) => {
    await gotoPty(page);
    const path = "./README.md";
    await emitPtyLine(page, `see ${path}\r\n`);
    await waitForBufferContains(page, path);

    const result = await activate(page, "file-download", path, "none");
    // provider 仍然找到 link (triggered=true 表示 provideLinks 有命中并调用了 activate),
    // 但 activate 内部 modifier gate 早返回, 不会发协议消息。
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(path);

    await page.waitForTimeout(50);
    const sent = await sentFakeRelayMessages(page);
    expect(sent.some((m: FakeRelayMessage) => m.type === "file_download_request")).toBe(false);
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
            m.type === "image_preview_request" &&
            m.sessionId === "claude-pty" &&
            m.path === path,
        );
      })
      .toBe(true);
  });

  // 用户截图复现: PTY 输出里裸文件路径 (无 ./ 前缀) 也应支持 cmd+click 下载。
  test("cmd+click on a bare relative path (no ./ prefix) triggers download", async ({ page }) => {
    await gotoPty(page);
    const path = "docs/superpowers/specs/2026-05-10-catos-mvk-tier1-acceptance.md";
    await emitPtyLine(page, `${path}: 验收说明\r\n`);
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
  });

  test("cmd+click on a top-level filename (README.md) triggers download", async ({ page }) => {
    await gotoPty(page);
    const path = "README.md";
    await emitPtyLine(page, `${path}: 项目说明\r\n`);
    await waitForBufferContains(page, path);

    const result = await activate(page, "file-download", path, "meta");
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(path);
  });

  test("plain click on an image path does NOT open preview", async ({ page }) => {
    await gotoPty(page);
    const path = ".dev-anywhere/clipboard/claude-pty/another.png";
    await emitPtyLine(page, `see @${path}\r\n`);
    await waitForBufferContains(page, path);

    await activate(page, "image-preview", path, "none");
    await page.waitForTimeout(50);
    await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeHidden();
    const sent = await sentFakeRelayMessages(page);
    expect(sent.some((m: FakeRelayMessage) => m.type === "image_preview_request")).toBe(false);
  });
});
