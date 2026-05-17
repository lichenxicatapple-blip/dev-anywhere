// 移动端 PTY 图片路径保留 tap 预览；文件下载路径 tap 不直接下载，避免误触。
// 文件下载走长按选区工具条。
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-touch-link";

test.describe("L4 mobile / PTY touch link activation", () => {
  test.setTimeout(60_000);

  async function emitLineAndAwait(
    page: import("@playwright/test").Page,
    payload: string,
    needle: string,
  ): Promise<void> {
    await page.evaluate((p) => {
      window.__ptySmoke.sendPty(p);
    }, payload);
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain(needle);
  }

  test("tap on a PTY file path does not trigger file_download", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emitLineAndAwait(emuPage, "see ./scripts/test.sh for details\r\n", "./scripts/test.sh");

    const result = await emuPage.evaluate(
      ({ sid, needle }) => window.__ccTest?.pty.activateLink(sid, "file-download", needle, "none"),
      { sid: SESSION_ID, needle: "./scripts/test.sh" },
    );
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe("./scripts/test.sh");

    await emuPage.waitForTimeout(300);
    expect(
      await emuPage.evaluate(() =>
        (window.__ptySmoke?.sent ?? []).some((raw) => {
          try {
            return (JSON.parse(raw) as { type?: string }).type === "file_download_request";
          } catch {
            return false;
          }
        }),
      ),
    ).toBe(false);
  });

  test("tap on a PTY image path opens image preview (no modifier on touch surface)", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emitLineAndAwait(
      emuPage,
      "saved screenshot to ./tmp/preview.png\r\n",
      "./tmp/preview.png",
    );

    const result = await emuPage.evaluate(
      ({ sid, needle }) => window.__ccTest?.pty.activateLink(sid, "image-preview", needle, "none"),
      { sid: SESSION_ID, needle: "./tmp/preview.png" },
    );
    expect(result?.triggered).toBe(true);

    // 预览 dialog 应弹起, 由 image_preview_request 驱动.
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__ptySmoke?.sent ?? []).some((raw) => {
            try {
              return (JSON.parse(raw) as { type?: string }).type === "image_preview_request";
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);
  });
});
