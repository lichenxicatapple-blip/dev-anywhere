import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import { ptyTerminal, readPtyDebugSnapshot, sendPtyOutput } from "../pty-scroll-helpers";

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

  test("keeps review geometry coherent while a mouse selection drags above the live screen", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-review-drag`,
      cols: 80,
      rows: 24,
      withVisualViewportMock: true,
    });
    await expectPtyTerminalMounted(page);
    await page.evaluate(() => localStorage.setItem("dev_anywhere_pty_scroll_trace", "1"));
    await page.evaluate(() => window.__ptySmoke.resize(80, 24));
    await page.waitForTimeout(100);
    await sendPtyOutput(
      page,
      Array.from(
        { length: 240 },
        (_, index) => `REVIEW DRAG LINE ${String(index).padStart(3, "0")}\r\n`,
      ).join(""),
    );
    await expect
      .poll(() =>
        page.evaluate(
          (sid) => window.__ccTest?.pty.serialize(sid) ?? "",
          `${SESSION_ID}-review-drag`,
        ),
      )
      .toContain("REVIEW DRAG LINE 239");

    const terminal = ptyTerminal(page);
    const terminalBox = await terminal.boundingBox();
    if (!terminalBox) throw new Error("PTY terminal is not visible");
    await page.mouse.move(
      terminalBox.x + terminalBox.width / 2,
      terminalBox.y + terminalBox.height / 2,
    );
    await page.mouse.wheel(0, -360);
    await expect
      .poll(async () => (await readPtyDebugSnapshot(page))?.verticalIntent.mode)
      .toBe("reviewing");

    const geometry = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
      const screen = container?.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
      if (!container || !screen) return null;
      const containerRect = container.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      return {
        container: {
          left: containerRect.left,
          top: containerRect.top,
          right: containerRect.right,
          bottom: containerRect.bottom,
        },
        screen: {
          left: screenRect.left,
          top: screenRect.top,
          right: screenRect.right,
          bottom: screenRect.bottom,
        },
        scrollTop: container.scrollTop,
      };
    });
    if (!geometry) throw new Error("PTY screen geometry is unavailable");

    // The bug needs a real review-projection gap: this point is already above xterm's live screen
    // (so SelectionService starts its private scroll timer), but is still far from the outer
    // container edge (where the old DEV Anywhere driver did nothing).
    const deadZoneY = geometry.screen.top - 8;
    expect(deadZoneY - geometry.container.top).toBeGreaterThan(40);
    const pointerX = Math.min(
      geometry.screen.right - 40,
      Math.max(geometry.screen.left + 40, geometry.container.left + 160),
    );
    const startY = Math.min(geometry.screen.bottom - 40, geometry.container.bottom - 40);

    await page.mouse.move(pointerX, startY);
    await page.mouse.down();
    try {
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window.__devAnywherePtyScrollTrace ?? []).some(
              (entry) => entry.event === "selection-drag:start",
            ),
          ),
        )
        .toBe(true);
      await page.mouse.move(pointerX, deadZoneY, { steps: 8 });
      await expect
        .poll(() => terminal.evaluate((element) => (element as HTMLElement).scrollTop))
        .toBeLessThan(geometry.scrollTop - 8);

      // Stop the outer RAF at a neutral point while keeping the left button held, then inject the
      // exact public xterm scrollLines call made by its 50 ms selection timer. The controller must
      // synchronously reject that second vertical owner instead of letting viewportY and host top
      // split apart as in the captured production trace.
      const currentScreen = await page
        .locator('[data-slot="pty-host"] .xterm-screen')
        .boundingBox();
      if (!currentScreen) throw new Error("PTY xterm screen disappeared during selection drag");
      await page.mouse.move(
        pointerX,
        Math.min(
          currentScreen.y + currentScreen.height - 60,
          currentScreen.y + currentScreen.height / 2,
        ),
      );
      await page.waitForTimeout(50);

      const beforePrivateScroll = await readPtyDebugSnapshot(page);
      if (!beforePrivateScroll) throw new Error("PTY debug snapshot is unavailable");
      expect(Math.abs(beforePrivateScroll.host.topDrift)).toBeLessThanOrEqual(1);
      await page.evaluate((sid) => {
        const term = window.__ccTestPtyTerminals?.get(sid);
        if (!term) throw new Error("PTY terminal test handle is unavailable");
        term.scrollLines(-6);
      }, `${SESSION_ID}-review-drag`);

      await page.waitForTimeout(50);
      const afterPrivateScroll = await readPtyDebugSnapshot(page);
      const traceTail = await page.evaluate(() =>
        (window.__devAnywherePtyScrollTrace ?? []).slice(-20).map((entry) => ({
          event: entry.event,
          viewportY: entry.viewportY,
          hostTopDrift: entry.hostTopDrift,
          details: entry.details,
        })),
      );
      expect(
        afterPrivateScroll && {
          hostTopDrift: afterPrivateScroll.host.topDrift,
          viewportY: afterPrivateScroll.term.viewportY,
        },
        JSON.stringify(traceTail, null, 2),
      ).toEqual({
        hostTopDrift: 0,
        viewportY: beforePrivateScroll.term.viewportY,
      });
    } finally {
      await page.mouse.up();
    }
  });
});
