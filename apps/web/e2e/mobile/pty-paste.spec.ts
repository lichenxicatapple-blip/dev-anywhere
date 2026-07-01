import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { ptyInput, sendPtyOutput } from "../pty-scroll-helpers";
import { touchPtyTerminalAndWaitForSoftKeyboard } from "./pty-soft-keyboard";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SESSION_ID = "mobile-pty-paste";

function xtermPastePayload(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function bracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${xtermPastePayload(text)}${BRACKETED_PASTE_END}`;
}

test.describe("L4 mobile / PTY paste", () => {
  test.setTimeout(60_000);

  test("paste button honors bracketed paste mode for Codex paste-burst handling", async ({
    emuPage,
  }) => {
    const pastedText = `mobile first\nmobile second\n${"y".repeat(800)}`;

    await emuPage.addInitScript((text) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () => Promise.resolve(text),
        },
      });
    }, pastedText);

    await setupPtyChat(emuPage, {
      sessionId: SESSION_ID,
      provider: "codex",
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await sendPtyOutput(emuPage, "\x1b[?2004h");
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTestPtyTerminals?.get(sid)?.modes.bracketedPasteMode ?? null,
          SESSION_ID,
        ),
      )
      .toBe(true);

    if (!(await touchPtyTerminalAndWaitForSoftKeyboard(emuPage))) {
      test.skip(true, "Android emulator did not expose a soft-keyboard visualViewport resize");
    }
    await expect(ptyInput(emuPage)).toBeFocused();
    await expect(emuPage.locator('[data-slot="pty-mobile-controls"]')).toBeVisible();
    await emuPage.locator('[data-slot="pty-mobile-key-paste"]').click();

    await expect.poll(() => readRawPtyInput(emuPage)).toBe(bracketedPastePayload(pastedText));
  });
});
