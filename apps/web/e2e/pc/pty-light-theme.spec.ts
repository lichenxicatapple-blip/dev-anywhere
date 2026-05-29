import { expect, test } from "@playwright/test";
import { BASE_URL } from "../helpers";
import { expectPtyTerminalMounted, installPtyFakeRelay } from "../pty-fixture";

test.describe("PTY light theme", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps xterm internals light on desktop", async ({ page }) => {
    const sessionId = "pc-light-pty";
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_theme", "light");
    });
    await installPtyFakeRelay(page, { sessionId, provider: "claude" });
    await page.goto(`${BASE_URL}/#/chat/${sessionId}?mode=pty`);
    await expectPtyTerminalMounted(page);

    await expect
      .poll(() =>
        page.evaluate((sid) => {
          return window.__ccTestPtyTerminals?.get(sid)?.options.theme?.background;
        }, sessionId),
      )
      .toBe("#F6F7F8");

    const colors = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
      const terminal = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
      const xterm = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm');
      const viewport = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-viewport');
      const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
      const helper = document.querySelector<HTMLElement>(
        '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
      );
      return {
        host: host ? getComputedStyle(host).backgroundColor : null,
        terminal: terminal ? getComputedStyle(terminal).backgroundColor : null,
        xterm: xterm ? getComputedStyle(xterm).backgroundColor : null,
        viewport: viewport ? getComputedStyle(viewport).backgroundColor : null,
        screen: screen ? getComputedStyle(screen).backgroundColor : null,
        helper: helper ? getComputedStyle(helper).backgroundColor : null,
      };
    });
    expect(colors).toEqual({
      host: "rgba(0, 0, 0, 0)",
      terminal: "rgb(246, 247, 248)",
      xterm: "rgb(246, 247, 248)",
      viewport: "rgb(246, 247, 248)",
      screen: "rgb(246, 247, 248)",
      helper: "rgba(0, 0, 0, 0)",
    });
  });
});
