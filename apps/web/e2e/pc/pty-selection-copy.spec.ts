import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pc-pty-selection-copy";

declare global {
  interface Window {
    __pcPtyCopiedText?: string;
  }
}

test.describe("PTY desktop selection copy", () => {
  test("copies the active xterm selection with the browser copy shortcut", async ({ page }) => {
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

    await page.evaluate(() => {
      window.__pcPtyCopiedText = "";
      document.addEventListener(
        "copy",
        (event) => {
          window.__pcPtyCopiedText = event.clipboardData?.getData("text/plain") ?? "";
        },
        { once: true },
      );
    });
    await page.keyboard.press("ControlOrMeta+C");

    await expect
      .poll(() => page.evaluate(() => window.__pcPtyCopiedText ?? ""))
      .toBe("PC COPY TARGET ALPHA");
  });
});
