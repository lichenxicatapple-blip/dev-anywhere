import { expect, test, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

function subscribeCount(messages: Array<Record<string, unknown>>, sessionId: string): number {
  return messages.filter((msg) => msg.type === "session_subscribe" && msg.sessionId === sessionId)
    .length;
}

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

  test("restores a following PTY to bottom when re-activated after hidden native scroll restore", async ({
    page,
  }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 180 },
          (_, i) => `keepalive restore line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect.poll(() => activePtyBottomGap(page)).toBeLessThanOrEqual(8);

    await page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await ptyEntry(page, "claude-pty")
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => {
        const node = el as HTMLElement;
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });

    await page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await expect.poll(() => activePtyBottomGap(page)).toBeLessThanOrEqual(8);
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
