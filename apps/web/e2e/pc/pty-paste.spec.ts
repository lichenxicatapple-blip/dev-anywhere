import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { ptyInput, sendPtyOutput } from "../pty-scroll-helpers";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

async function waitForBracketedPasteMode(
  page: Page,
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (sid) => window.__ccTestPtyTerminals?.get(sid)?.modes.bracketedPasteMode ?? null,
        sessionId,
      ),
    )
    .toBe(enabled);
}

async function dispatchTextPaste(target: Locator, text: string): Promise<void> {
  await target.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, text);
}

function xtermPastePayload(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function bracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${xtermPastePayload(text)}${BRACKETED_PASTE_END}`;
}

test.describe("PTY paste", () => {
  test("uses bracketed paste only after the remote TUI enables it", async ({ page }) => {
    const bracketedSessionId = "pty-paste-desktop-bracketed";
    const plainSessionId = "pty-paste-desktop-plain";
    const pastedText = `first line\nsecond line\n${"x".repeat(800)}`;
    const plainText = "first line\nsecond line";

    await setupPtyChat(page, { sessionId: bracketedSessionId, provider: "codex" });
    await expectPtyTerminalMounted(page);
    await sendPtyOutput(page, "\x1b[?2004h");
    await waitForBracketedPasteMode(page, bracketedSessionId, true);

    await ptyInput(page).focus();
    await dispatchTextPaste(ptyInput(page), pastedText);

    await expect.poll(() => readRawPtyInput(page)).toBe(bracketedPastePayload(pastedText));

    await setupPtyChat(page, { sessionId: plainSessionId, provider: "codex" });
    await expectPtyTerminalMounted(page);
    await waitForBracketedPasteMode(page, plainSessionId, false);

    await ptyInput(page).focus();
    await dispatchTextPaste(ptyInput(page), plainText);

    await expect.poll(() => readRawPtyInput(page)).toBe(xtermPastePayload(plainText));
  });
});
