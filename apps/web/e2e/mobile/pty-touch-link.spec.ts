// 移动端 PTY 链接没有 cmd/ctrl 修饰键，tap 已高亮的路径就是明确操作。
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
      .poll(() =>
        page.evaluate(
          (sid) => (window.__ccTest?.pty.serialize(sid) ?? "").replace(/\n/g, ""),
          SESSION_ID,
        ),
      )
      .toContain(needle);
  }

  test("tap on a PTY file path triggers file_download", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emitLineAndAwait(emuPage, "see ./scripts/test.sh for details\r\n", "./scripts/test.sh");

    const result = await emuPage.evaluate(
      ({ sid, needle }) => window.__ccTest?.pty.activateLink(sid, "file-download", needle, "none"),
      { sid: SESSION_ID, needle: "./scripts/test.sh" },
    );
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe("./scripts/test.sh");

    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__ptySmoke?.sent ?? []).some((raw) => {
            try {
              const msg = JSON.parse(raw) as { type?: string; path?: string };
              return msg.type === "file_download_request" && msg.path === "./scripts/test.sh";
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);
  });

  test("tap on an xterm-wrapped PTY document path triggers file_download", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    const path =
      "/Users/catli/MyApps/AIMovieFactory/docs/superpowers/specs/2026-05-24-v1-open-source-research.md";
    await emitLineAndAwait(emuPage, `  - ${path}\r\n`, "open-source-research.md");

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          return term ? { cols: term.cols, rows: term.rows } : null;
        }, SESSION_ID),
      )
      .toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });

    const metrics = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      return term ? { cols: term.cols, rows: term.rows } : null;
    }, SESSION_ID);
    expect(metrics?.cols ?? 0).toBeLessThan(path.length);

    const result = await emuPage.evaluate(
      ({ sid, needle }) => window.__ccTest?.pty.activateLink(sid, "file-download", needle, "none"),
      { sid: SESSION_ID, needle: path },
    );
    expect(result?.triggered).toBe(true);
    expect(result?.text).toBe(path);

    await expect
      .poll(() =>
        emuPage.evaluate(
          (expectedPath) =>
            (window.__ptySmoke?.sent ?? []).some((raw) => {
              try {
                const msg = JSON.parse(raw) as { type?: string; path?: string };
                return msg.type === "file_download_request" && msg.path === expectedPath;
              } catch {
                return false;
              }
            }),
          path,
        ),
      )
      .toBe(true);
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
