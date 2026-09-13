import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";
import { waitForStableVisiblePtyRow } from "../pty-scroll-helpers";

const SESSION_ID = "mobile-url-selection";
const COLS = 32;
const ROWS = 12;

async function locateText(page: Page, text: string, pressOffset: number) {
  return page.evaluate(
    ({ sid, text, pressOffset }) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      const container = screen?.closest<HTMLElement>('[data-slot="pty-terminal"]');
      if (!term || !screen || !container) return null;
      const buffer = term.buffer.active;
      for (let row = buffer.viewportY; row < buffer.length; row += 1) {
        if (!buffer.getLine(row)?.translateToString(true).startsWith("URL ")) continue;
        const offset = 4 + pressOffset;
        const targetRow = row + Math.floor(offset / term.cols);
        const rect = screen.getBoundingClientRect();
        const clip = container.getBoundingClientRect();
        const point = {
          x: rect.left + ((offset % term.cols) + 0.5) * (rect.width / term.cols),
          y: rect.top + (targetRow - buffer.viewportY + 0.5) * (rect.height / term.rows),
        };
        if (
          point.x < clip.left ||
          point.x >= clip.right ||
          point.y < clip.top ||
          point.y >= clip.bottom
        ) {
          return null;
        }
        return {
          point,
          anchorRow: row,
          anchorColumn: 4,
          focusRow: row + Math.floor((4 + text.length - 1) / term.cols),
          focusColumn: (4 + text.length - 1) % term.cols,
        };
      }
      return null;
    },
    { sid: SESSION_ID, text, pressOffset },
  );
}

test.describe("mobile PTY initial selection and clipboard", () => {
  test.setTimeout(60_000);
  test.describe.configure({ retries: 0 });

  for (const sample of [
    { text: "x.com?user=cat", pressOffset: 2, file: false },
    {
      text: "https://example.com/path?user=cat&next=%2Fa%3Fb%3D1#section",
      pressOffset: 38,
      file: false,
    },
    { text: "x.com/report.md?download=cat.txt", pressOffset: 12, file: false },
    { text: "ftp://cat@example.com:2121/pub/report.txt;type=i", pressOffset: 38, file: false },
    { text: "./build/report.md", pressOffset: 10, file: true },
    { text: "ordinary", pressOffset: 2, file: false },
  ]) {
    test(`long press copies the complete token: ${sample.text}`, async ({ emuPage: page }) => {
      await setupPtyChat(page, {
        sessionId: SESSION_ID,
        sessionKind: "agent",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        cols: COLS,
        rows: ROWS,
        baseUrl: mobileBaseUrl,
      });
      await expectPtyTerminalMounted(page, { timeout: 30_000 });
      await expect
        .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
        .toContain("PTY SMOKE READY");
      await page.evaluate(
        ({ cols, rows, text }) => {
          window.__ptySmoke.resize(cols, rows);
          window.__ptySmoke.sendPty(`\x1b[2J\x1b[H\r\nURL ${text}, done\r\nEND\r\n`);
        },
        { cols: COLS, rows: ROWS, text: sample.text },
      );
      await expect
        .poll(() =>
          page.evaluate(
            (sid) => (window.__ccTest?.pty.serialize(sid) ?? "").replace(/\n/g, ""),
            SESSION_ID,
          ),
        )
        .toContain(sample.text);
      await waitForStableVisiblePtyRow(page, `URL ${sample.text.slice(0, 8)}`);
      await expect.poll(() => locateText(page, sample.text, sample.pressOffset)).not.toBeNull();
      const target = await locateText(page, sample.text, sample.pressOffset);
      if (!target) throw new Error("Selection target is outside the visible terminal");

      const client = await page.context().newCDPSession(page);
      try {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...target.point, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
        });
        await page.waitForTimeout(650);
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        const overlay = page.locator('[data-slot="pty-managed-selection-overlay"]');
        await expect(overlay).toHaveAttribute("data-anchor-row", String(target.anchorRow));
        await expect(overlay).toHaveAttribute("data-anchor-column", String(target.anchorColumn));
        await expect(overlay).toHaveAttribute("data-focus-row", String(target.focusRow));
        await expect(overlay).toHaveAttribute("data-focus-column", String(target.focusColumn));
        await expect(page.getByRole("button", { name: "下载终端选区文件" })).toHaveCount(
          sample.file ? 1 : 0,
        );
        await expect(page.getByRole("button", { name: "预览终端选区图片" })).toHaveCount(0);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(page.url()).origin,
        });
        const copy = page.getByRole("button", { name: "复制终端选区" });
        await expect(copy).toBeVisible();
        const copyBox = await copy.boundingBox();
        if (!copyBox) throw new Error("Copy button has no touch target");
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            {
              x: copyBox.x + copyBox.width / 2,
              y: copyBox.y + copyBox.height / 2,
              id: 2,
              radiusX: 3,
              radiusY: 3,
              force: 1,
            },
          ],
        });
        await page.waitForTimeout(70);
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(sample.text);
      } finally {
        await client.detach();
      }
    });
  }
});
