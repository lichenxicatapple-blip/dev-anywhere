import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "ipad-pty-session-geometry";

test.describe("iPad Safari PTY session geometry", () => {
  test.use({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1",
  });

  test("restores session-owned geometry from the server snapshot", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        get: () => "MacIntel",
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        get: () => 5,
      });
    });
    await setupPtyChat(page, {
      sessionId: SESSION_ID,
      sessionKind: "terminal",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 100,
      rows: 30,
      snapshotData: `${"QR".repeat(48)}\r\n$ `,
    });
    await expectPtyTerminalMounted(page);

    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          const wrappedLines = Array.from(
            { length: term.buffer.active.length },
            (_, index) => term.buffer.active.getLine(index)?.isWrapped === true,
          ).filter(Boolean).length;
          return { cols: term.cols, rows: term.rows, wrappedLines };
        }, SESSION_ID),
      )
      .toEqual({ cols: 100, rows: 30, wrappedLines: 0 });

    const resizeRequests = await page.evaluate(() =>
      window.__ptySmoke.sent.filter((raw) => {
        try {
          return (JSON.parse(raw) as { type?: string }).type === "terminal_resize_request";
        } catch {
          return false;
        }
      }),
    );
    expect(resizeRequests).toEqual([]);
  });
});
