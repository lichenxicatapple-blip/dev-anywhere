import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pc-pty-selection-copy";

test.describe("PTY desktop selection copy", () => {
  test("exports the active xterm selection through the browser copy event", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await page.evaluate(() => {
      window.__ptySmoke.sendPty("PC COPY TARGET ALPHA\r\nPC COPY TARGET OMEGA\r\n");
    });
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("PC COPY TARGET OMEGA");

    const selected = await page.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      if (!term) return null;
      for (let row = term.buffer.active.viewportY; row < term.buffer.active.length; row += 1) {
        const line = term.buffer.active.getLine(row)?.translateToString(true) ?? "";
        const start = line.indexOf("PC COPY TARGET ALPHA");
        if (start < 0) continue;
        term.select(start, row, "PC COPY TARGET ALPHA".length);
        term.focus();
        return term.getSelection();
      }
      return null;
    }, SESSION_ID);
    expect(selected).toBe("PC COPY TARGET ALPHA");

    const copied = await page.evaluate(() => {
      const terminal = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm');
      if (!terminal) return null;
      const clipboardData = new DataTransfer();
      terminal.dispatchEvent(
        new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe(selected);
  });
});
