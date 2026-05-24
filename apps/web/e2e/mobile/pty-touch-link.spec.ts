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

  async function findPtyLinkTapPoint(
    page: import("@playwright/test").Page,
    options: { sid: string; kind: "file-download" | "image-preview"; needle: string },
  ): Promise<{ x: number; y: number } | null> {
    return page.evaluate(({ sid, kind, needle }) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const provider = window.__ccTestPtyLinkProviders?.get(`${sid}/${kind}`);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !provider || !screen) return null;

      const buffer = term.buffer.active;
      const firstVisibleLine = buffer.viewportY + 1;
      const lastVisibleLine = buffer.viewportY + term.rows;
      const rect = screen.getBoundingClientRect();
      const cellWidth = screen.clientWidth / term.cols;
      const cellHeight = screen.clientHeight / term.rows;

      for (let lineNumber = firstVisibleLine; lineNumber <= lastVisibleLine; lineNumber += 1) {
        let point: { x: number; y: number } | null = null;
        provider.provideLinks(lineNumber, (links) => {
          const link = links?.find((candidate) => candidate.text === needle);
          if (!link) return;
          const startColumn = lineNumber === link.range.start.y ? link.range.start.x : 1;
          const endColumn = lineNumber === link.range.end.y ? link.range.end.x : term.cols;
          const column = Math.max(startColumn, Math.min(endColumn, startColumn + 2));
          point = {
            x: rect.left + (column - 0.5) * cellWidth,
            y: rect.top + (lineNumber - buffer.viewportY - 0.5) * cellHeight,
          };
        });
        if (point) return point;
      }
      return null;
    }, options);
  }

  async function tapPtyLink(
    page: import("@playwright/test").Page,
    options: { sid: string; kind: "file-download" | "image-preview"; needle: string },
  ): Promise<void> {
    const point = await expect
      .poll(() => findPtyLinkTapPoint(page, options), { timeout: 10_000 })
      .not.toBeNull()
      .then(() => findPtyLinkTapPoint(page, options));
    if (!point) throw new Error(`PTY link is not tappable: ${options.needle}`);
    const client = await page.context().newCDPSession(page);
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: point.x, y: point.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
      });
      await page.waitForTimeout(60);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await client.detach();
    }
  }

  test("tap on a PTY file path triggers file_download", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emitLineAndAwait(emuPage, "see ./scripts/test.sh for details\r\n", "./scripts/test.sh");

    await tapPtyLink(emuPage, {
      sid: SESSION_ID,
      kind: "file-download",
      needle: "./scripts/test.sh",
    });

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

    await tapPtyLink(emuPage, {
      sid: SESSION_ID,
      kind: "file-download",
      needle: path,
    });

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

    await tapPtyLink(emuPage, {
      sid: SESSION_ID,
      kind: "image-preview",
      needle: "./tmp/preview.png",
    });

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
