import { expect, test, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { ptyInput } from "../pty-scroll-helpers";

async function parseRemoteOutput(page: Page, sessionId: string, data: string): Promise<void> {
  // Wait through xterm's public parser event so split sequences really span separate writes.
  // Deliver through the relay fixture, preserving the application's normal output/input path.
  await page.evaluate(
    ({ sid, output }) =>
      new Promise<void>((resolve) => {
        const terminal = window.__ccTestPtyTerminals?.get(sid);
        if (!terminal) throw new Error("PTY terminal is unavailable");
        const parsed = terminal.onWriteParsed(() => {
          parsed.dispose();
          resolve();
        });
        window.__ptySmoke.sendPty(output);
      }),
    { sid: sessionId, output: data },
  );
}

test.describe("PTY terminal query ownership", () => {
  test.use({ viewport: { width: 1210, height: 702 } });

  for (const ptyOwner of ["proxy-hosted", "local-terminal"] as const) {
    test(`${ptyOwner} leaves color query replies to the owner without suppressing input or color setters`, async ({
      page,
    }) => {
      const sessionId = `pty-terminal-queries-${ptyOwner}`;
      await setupPtyChat(page, {
        sessionId,
        sessionKind: "agent",
        provider: "codex",
        ptyOwner,
        snapshotData: "READY\r\n$ ",
        cols: 60,
        rows: 24,
      });
      await expectPtyTerminalMounted(page);

      // Both OSC identifiers accept BEL and ST. Include chunks inside the command and ST
      // terminator: an answer from this mirrored viewer would become remote keyboard input.
      const queries = [
        ["\x1b]10;?\x07"],
        ["\x1b]11;?\x1b\\"],
        ["\x1b]", "10;", "?\x1b", "\\"],
        ["\x1b]11", ";?", "\x07"],
      ];
      for (const chunks of queries) {
        for (const chunk of chunks) await parseRemoteOutput(page, sessionId, chunk);
        expect(await readRawPtyInput(page)).toBe("");
      }

      // A different terminal query must still reach xterm and return its normal response.
      await parseRemoteOutput(page, sessionId, "\x1b[4;6H\x1b[6n");
      await expect.poll(() => readRawPtyInput(page)).toBe("\x1b[4;6R");

      // OSC setters remain active. Inverse text exposes the default background as its visible
      // foreground, allowing both colors to be checked through rendering, not private internals.
      await parseRemoteOutput(
        page,
        sessionId,
        "\x1b]10;#123456\x07\x1b]11;#654321\x1b\\" +
          "\x1b[2J\x1b[HNORMAL-COLOR\r\n\x1b[7mINVERSE-COLOR\x1b[0m\r\n$ ",
      );
      const rows = page.locator('[data-slot="pty-host"] .xterm-rows > div');
      await expect(rows.filter({ hasText: "NORMAL-COLOR" }).locator("span").first()).toHaveCSS(
        "color",
        "rgb(18, 52, 86)",
      );
      await expect(rows.filter({ hasText: "INVERSE-COLOR" }).locator("span").first()).toHaveCSS(
        "color",
        "rgb(101, 67, 33)",
      );

      await ptyInput(page).focus();
      await page.keyboard.type("typed");
      await ptyInput(page).evaluate((input) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "first\nsecond");
        input.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
        );
      });
      await expect.poll(() => readRawPtyInput(page)).toBe("\x1b[4;6Rtypedfirst\rsecond");
    });
  }
});
