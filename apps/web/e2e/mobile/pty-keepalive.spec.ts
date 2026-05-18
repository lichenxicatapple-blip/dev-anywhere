import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

function activePty(page: Page) {
  return page.locator('[data-slot="pty-keepalive-entry"][data-active="true"]');
}

function ptyEntry(page: Page, sessionId: string) {
  return page.locator(`[data-slot="pty-keepalive-entry"][data-session-id="${sessionId}"]`);
}

async function activePtyBottomGap(page: Page): Promise<number> {
  return activePty(page)
    .locator('[data-slot="pty-terminal"]')
    .evaluate((el) => {
      const node = el as HTMLElement;
      return Math.max(0, node.scrollHeight - node.clientHeight) - node.scrollTop;
    });
}

test.describe("L4 mobile / PTY keep-alive restore", () => {
  test.setTimeout(60_000);

  test("restores a following PTY to bottom when re-activated after hidden native scroll restore", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/?pty-keepalive=${Date.now()}`);
    await gotoWithFakeProxy(emuPage, "/#/chat/claude-pty?mode=pty");

    await expect(activePty(emuPage).locator('[data-slot="pty-host"] .xterm')).toBeVisible({
      timeout: 30_000,
    });
    await emuPage.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 180 },
          (_, i) => `mobile keepalive restore line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect.poll(() => activePtyBottomGap(emuPage)).toBeLessThanOrEqual(8);

    await emuPage.goto(`${mobileBaseUrl}/#/chat/codex-pty?mode=pty`);
    await expect(activePty(emuPage).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await ptyEntry(emuPage, "claude-pty")
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => {
        const node = el as HTMLElement;
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });

    await emuPage.goto(`${mobileBaseUrl}/#/chat/claude-pty?mode=pty`);
    await expect(activePty(emuPage).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await expect.poll(() => activePtyBottomGap(emuPage)).toBeLessThanOrEqual(8);
  });
});
