import { expect, test, type Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";
import { expectPtyCursorAwareBottom, expectPtyRendered } from "../pty-scroll-helpers";

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
    await expect(activePty(page).locator(".xterm-helper-textarea")).toBeFocused();

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty("claude-pty", "BACKGROUND-LIVE-FRAME\r\n");
    });

    await page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await expect(activePty(page).locator(".xterm-helper-textarea")).toBeFocused();
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
    await expectPtyCursorAwareBottom(page);

    await page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await expect(ptyEntry(page, "codex-pty")).toHaveAttribute("data-active", "true");
    await expect(
      ptyEntry(page, "codex-pty").locator('[data-slot="pty-host"] .xterm'),
    ).toBeVisible();

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

    await expectPtyCursorAwareBottom(page);
  });

  test("returns a re-activated reviewing PTY to live output without retaining restore state", async ({
    page,
  }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 180 },
          (_, i) => `review resume line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expectPtyCursorAwareBottom(page);

    const terminal = activePty(page).locator('[data-slot="pty-terminal"]');
    const terminalScreen = activePty(page).locator('[data-slot="pty-host"] .xterm-screen');
    await terminalScreen.hover();
    await page.mouse.wheel(0, -600);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      false,
    );
    await expectPtyRendered(page);

    await page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await expect(ptyEntry(page, "claude-pty")).toHaveAttribute("data-active", "false");

    // 模拟隐藏标签页期间 Chrome 回放错误 DOM 位置，同时终端继续产生输出。
    await ptyEntry(page, "claude-pty")
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => {
        const node = el as HTMLElement;
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty("claude-pty", "BACKGROUND-REVIEW-FRAME\r\n");
    });

    await page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await expectPtyCursorAwareBottom(page);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      true,
    );
    await expect(
      activePty(page).locator('[data-slot="back-to-bottom-new-indicator"]'),
    ).toBeHidden();
    await expectPtyRendered(page);

    // The lifecycle transaction is finished. A later user wheel must own the viewport instead of
    // being pulled back by another render.
    const liveScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    await terminalScreen.hover();
    await page.mouse.wheel(0, -120);
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThan(liveScrollTop);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      false,
    );
  });

  test("does not restore stale review after typing resumes live output", async ({ page }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from(
          { length: 180 },
          (_, i) => `stale review line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expectPtyCursorAwareBottom(page);

    const terminal = activePty(page).locator('[data-slot="pty-terminal"]');
    await terminal.hover();
    await page.mouse.wheel(0, -600);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      false,
    );

    await activePty(page)
      .locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]')
      .focus();
    await page.keyboard.type("resume");
    await expect
      .poll(async () =>
        sentFakeRelayMessages(page).then((messages) =>
          messages
            .filter((message) => message.type === "remote_input_raw")
            .map((message) => String(message.data ?? ""))
            .join(""),
        ),
      )
      .toContain("resume");
    await expectPtyCursorAwareBottom(page);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      true,
    );

    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from({ length: 20 }, (_, i) => `active follow frame ${i}\r\n`).join(""),
      );
    });
    await expectPtyCursorAwareBottom(page);

    await page.locator('[data-slot="session-row"][data-session-id="codex-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/codex-pty\?mode=pty/);
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from({ length: 20 }, (_, i) => `background follow frame ${i}\r\n`).join(""),
      );
    });

    await page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible').click();
    await expect(page).toHaveURL(/\/chat\/claude-pty\?mode=pty/);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        }),
    );
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from({ length: 20 }, (_, i) => `resumed live frame ${i}\r\n`).join(""),
      );
    });
    await expectPtyCursorAwareBottom(page);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      true,
    );
    await expect(
      activePty(page).locator('[data-slot="back-to-bottom-new-indicator"]'),
    ).toBeHidden();
  });

  test("returns a reviewing PTY to live output after Chrome visibility background reconnect", async ({
    page,
  }) => {
    await expect(activePty(page).locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitPty(
        "claude-pty",
        Array.from({ length: 180 }, (_, i) => `tab resume line ${i}\r\n`).join(""),
      );
    });
    await expectPtyCursorAwareBottom(page);

    const terminal = activePty(page).locator('[data-slot="pty-terminal"]');
    await terminal.hover();
    await page.mouse.wheel(0, -600);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      false,
    );
    await expectPtyRendered(page);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const node = document.querySelector<HTMLElement>(
        '[data-slot="pty-keepalive-entry"][data-active="true"] [data-slot="pty-terminal"]',
      );
      if (node) {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      window.__devAnywhereE2E?.socket?.emitPty("claude-pty", "TAB-BACKGROUND-FRAME\r\n");
    });
    await page.waitForTimeout(5_200);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expectPtyCursorAwareBottom(page);
    await expect(activePty(page).locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
      "inert",
      true,
    );
    await expect(
      activePty(page).locator('[data-slot="back-to-bottom-new-indicator"]'),
    ).toBeHidden();
    await expectPtyRendered(page);
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
    await expectPtyRendered(page);
  });
});
