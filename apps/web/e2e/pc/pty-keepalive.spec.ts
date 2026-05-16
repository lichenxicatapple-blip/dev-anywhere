import { expect, test, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

function subscribeCount(messages: Array<Record<string, unknown>>, sessionId: string): number {
  return messages.filter((msg) => msg.type === "session_subscribe" && msg.sessionId === sessionId)
    .length;
}

function activePty(page: Page) {
  return page.locator('[data-slot="pty-keepalive-entry"][data-active="true"]');
}

test.describe("PTY keep-alive", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
  });

  test("keeps a recently used PTY session subscribed while switching away and back", async ({
    page,
  }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expect
      .poll(async () => subscribeCount(await sentFakeRelayMessages(page), "claude-pty"))
      .toBe(1);

    await page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty("claude-pty", "BACKGROUND-LIVE-FRAME\r\n");
    });

    await page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await expect
      .poll(() =>
        page.evaluate((sessionId) => window.__ccTest?.pty.serialize(sessionId) ?? "", "claude-pty"),
      )
      .toContain("BACKGROUND-LIVE-FRAME");

    const messages = await sentFakeRelayMessages(page);
    expect(subscribeCount(messages, "claude-pty")).toBe(1);
  });

  test("renders the active PTY after a hard reload on the chat route", async ({ page }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate((sessionId) => window.__ccTest?.pty.serialize(sessionId) ?? "", "claude-pty"),
      )
      .not.toBe("");
  });
});
