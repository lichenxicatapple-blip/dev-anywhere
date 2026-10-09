import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import { readVisiblePtyRow, sendPtyOutput } from "../pty-scroll-helpers";

// Codex 0.159.2's inline Folder access dialog hides the hardware cursor and ends
// synchronized output after painting its footer; it does not restore an input caret.
// Keep that sequence, with a fixed test path and simplified text/style.
const folderDialog =
  "\x1b[?2026h\x1b[?25l\x1b[1;1H\x1b[J" +
  "\x1b[2;1H  Folder access" +
  "\x1b[3;3HC:\\work\\untrusted-project" +
  "\x1b[6;3HTrust this folder?" +
  "\x1b[7;3HContinue only if you trust these files." +
  "\x1b[10;1H> 1. Trust and continue" +
  "\x1b[11;3H2. Quit" +
  "\x1b[13;3Henter continue · esc quit\x1b[?2026l";

test.use({ viewport: { width: 360, height: 704 }, hasTouch: true });

for (const ptyOwner of ["proxy-hosted", "local-terminal"] as const) {
  for (const delivery of ["live", "live-after-scroll", "snapshot"] as const) {
    test(`shows hidden-cursor dialog choices for ${ptyOwner} ${delivery} output`, async ({
      page,
    }, testInfo) => {
      await setupPtyChat(page, {
        sessionId: `hidden-dialog-${ptyOwner}-${delivery}`,
        sessionKind: "agent",
        provider: "codex",
        ptyOwner,
        cols: 100,
        rows: 70,
        snapshotData:
          delivery === "snapshot"
            ? folderDialog
            : delivery === "live-after-scroll"
              ? "\x1b[?25h\x1b[61;1HStarting Codex\x1b[67;3H> \x1b[67;3H"
              : "\x1b[?25h\x1b[1;1HStarting Codex\x1b[7;3H",
      });
      await expectPtyTerminalMounted(page);
      if (delivery === "live") await sendPtyOutput(page, folderDialog);
      if (delivery === "live-after-scroll") {
        // Captured inline Codex startup from an existing terminal: the area above its UI
        // moves into scrollback before the dialog replaces the composer near the live top.
        await sendPtyOutput(
          page,
          "\x1b[?2026h\x1b[1;59r\x1b[59;1H" + "\r\n".repeat(59) + "\x1b[r" + folderDialog,
        );
      }

      // Buffer contents alone would pass while the spacer clips these rows. Check actual
      // painted rows against the mobile viewport, without trusting the directory or typing.
      for (const text of ["Folder access", "1. Trust and continue", "2. Quit", "esc quit"]) {
        await expect.poll(() => readVisiblePtyRow(page, text)).not.toBeNull();
        const row = (await readVisiblePtyRow(page, text))!;
        expect(row.top).toBeGreaterThanOrEqual(-1);
        const contentHeight = await page.evaluate(
          () => window.__devAnywherePtyDebug!()!.visibleContentHeight,
        );
        expect(row.bottom).toBeLessThanOrEqual(contentHeight + 1);
      }
      await testInfo.attach("folder-dialog", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
}
