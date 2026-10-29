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

type Point = { x: number; y: number };

async function terminalMenuPoints(
  page: Page,
): Promise<Record<"top" | "side" | "bottom" | "word", Point>> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = container?.querySelector<HTMLElement>(".xterm-screen");
    const row = Array.from(screen?.querySelectorAll<HTMLElement>(".xterm-rows > div") ?? []).find(
      (element) => element.textContent?.includes("copy_me"),
    );
    if (!container || !screen || !row) throw new Error("Shell prompt geometry is unavailable");
    const bounds = container.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    return {
      top: { x: bounds.left + 60, y: bounds.top + 25 },
      side: { x: (screenBounds.right + bounds.right) / 2, y: rowBounds.top + rowBounds.height / 2 },
      bottom: { x: bounds.left + 60, y: bounds.bottom - 4 },
      word: { x: rowBounds.left + 24, y: rowBounds.top + rowBounds.height / 2 },
    };
  });
}

async function openNativeMenuTarget(page: Page, point: Point): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __pasteContextMenuPrevented?: boolean };
    delete state.__pasteContextMenuPrevented;
    document.addEventListener(
      "contextmenu",
      (event) => {
        queueMicrotask(() => {
          state.__pasteContextMenuPrevented = event.defaultPrevented;
        });
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.click(point.x, point.y, { button: "right" });

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pasteContextMenuPrevented?: boolean })
            .__pasteContextMenuPrevented,
      ),
    )
    .toBe(false);
}

async function expectEditableMenuTarget(
  page: Page,
  point: Point,
  selectedText: string,
): Promise<void> {
  // Native menu contents live outside the page. Assert its actual editable hit target, not just
  // focus or a CSS flag; those can both be correct while the browser still opens a page menu.
  await expect
    .poll(() =>
      ptyInput(page).evaluate((input, position) => {
        const textarea = input as HTMLTextAreaElement;
        return {
          hit: document.elementFromPoint(position.x, position.y) === textarea,
          focused: document.activeElement === textarea,
          editable: !textarea.readOnly && !textarea.disabled,
          value: textarea.value,
          selection: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
        };
      }, point),
    )
    .toEqual({
      hit: true,
      focused: true,
      editable: true,
      value: selectedText,
      selection: selectedText,
    });
}

test.describe("PTY paste", () => {
  test("uses bracketed paste only after the remote TUI enables it", async ({ page }) => {
    const bracketedSessionId = "pty-paste-desktop-bracketed";
    const plainSessionId = "pty-paste-desktop-plain";
    const pastedText = `first line\nsecond line\n${"x".repeat(800)}`;
    const plainText = "first line\nsecond line";

    await setupPtyChat(page, {
      sessionId: bracketedSessionId,
      sessionKind: "agent",
      provider: "codex",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
    });
    await expectPtyTerminalMounted(page);
    await sendPtyOutput(page, "\x1b[?2004h");
    await waitForBracketedPasteMode(page, bracketedSessionId, true);

    await ptyInput(page).focus();
    await dispatchTextPaste(ptyInput(page), pastedText);

    await expect.poll(() => readRawPtyInput(page)).toBe(bracketedPastePayload(pastedText));

    await setupPtyChat(page, {
      sessionId: plainSessionId,
      sessionKind: "agent",
      provider: "codex",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
    });
    await expectPtyTerminalMounted(page);
    await waitForBracketedPasteMode(page, plainSessionId, false);

    await ptyInput(page).focus();
    await dispatchTextPaste(ptyInput(page), plainText);

    await expect.poll(() => readRawPtyInput(page)).toBe(xtermPastePayload(plainText));
  });
});

test.describe("PTY native context-menu paste target", () => {
  test.use({ viewport: { width: 1210, height: 702 } });

  for (const sessionKind of ["terminal", "agent"] as const) {
    test(`${sessionKind} exposes its original editable input over blank terminal regions`, async ({
      page,
    }) => {
      await setupPtyChat(page, {
        sessionId: `pty-context-menu-${sessionKind}`,
        sessionKind,
        provider: "claude",
        ptyOwner: "proxy-hosted",
        snapshotData: "copy_me $ ",
        cols: 60,
        rows: 24,
      });
      await expectPtyTerminalMounted(page);
      await expect(page.locator(".xterm-rows")).toContainText("copy_me");
      const originalInput = await ptyInput(page).elementHandle();
      if (!originalInput) throw new Error("Original xterm input is unavailable");
      const points = await terminalMenuPoints(page);

      for (const position of ["top", "side", "bottom"] as const) {
        await openNativeMenuTarget(page, points[position]);
        await expectEditableMenuTarget(page, points[position], "");
        expect(await originalInput.evaluate((input) => input === document.activeElement)).toBe(
          true,
        );
        await expect(ptyInput(page)).toHaveCount(1);
      }
      expect(await readRawPtyInput(page)).toBe("");
      await dispatchTextPaste(ptyInput(page), "first\nsecond");
      await expect.poll(() => readRawPtyInput(page)).toBe("first\rsecond");
      await expect(ptyInput(page)).not.toHaveAttribute("data-pty-context-menu");
    });
  }

  test("preserves a managed selection for Copy and clears it after menu Paste", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: "pty-context-menu-selection",
      sessionKind: "terminal",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      snapshotData: "copy_me $ ",
      cols: 60,
      rows: 24,
    });
    await expectPtyTerminalMounted(page);
    await expect(page.locator(".xterm-rows")).toContainText("copy_me");
    const points = await terminalMenuPoints(page);
    await page.mouse.dblclick(points.word.x, points.word.y);
    await expect(page.locator('[data-slot="pty-managed-selection-overlay"]')).toHaveCount(1);
    await openNativeMenuTarget(page, points.word);
    await expectEditableMenuTarget(page, points.word, "copy_me");
    await openNativeMenuTarget(page, points.top);
    await expectEditableMenuTarget(page, points.top, "copy_me");

    const copied = await ptyInput(page).evaluate((input) => {
      const data = new DataTransfer();
      const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      input.dispatchEvent(event);
      return { text: data.getData("text/plain"), handled: event.defaultPrevented };
    });
    expect(copied).toEqual({ text: "copy_me", handled: true });
    await expect(ptyInput(page)).not.toHaveAttribute("data-pty-context-menu");
    expect(await readRawPtyInput(page)).toBe("");

    await sendPtyOutput(page, "\x1b[?2004h");
    await waitForBracketedPasteMode(page, "pty-context-menu-selection", true);
    await openNativeMenuTarget(page, points.top);
    await expectEditableMenuTarget(page, points.top, "copy_me");
    await dispatchTextPaste(ptyInput(page), "pasted\ncommand");
    await expect.poll(() => readRawPtyInput(page)).toBe(bracketedPastePayload("pasted\ncommand"));
    await expect(page.locator('[data-slot="pty-managed-selection-overlay"]')).toHaveCount(0);
    await expect(ptyInput(page)).not.toHaveAttribute("data-pty-context-menu");
  });

  test("keeps the menu target under the pointer while output moves the remote cursor", async ({
    page,
  }) => {
    const sessionId = "pty-context-menu-output";
    await setupPtyChat(page, {
      sessionId,
      sessionKind: "agent",
      provider: "codex",
      ptyOwner: "proxy-hosted",
      snapshotData: "copy_me $ ",
      cols: 60,
      rows: 24,
    });
    await expectPtyTerminalMounted(page);
    await expect(page.locator(".xterm-rows")).toContainText("copy_me");
    const { top } = await terminalMenuPoints(page);
    await openNativeMenuTarget(page, top);
    await expectEditableMenuTarget(page, top, "");
    for (let index = 1; index <= 4; index += 1) {
      await sendPtyOutput(page, `\r\nprogress ${index}`);
      await expect
        .poll(() =>
          page.evaluate(
            (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.cursorY,
            sessionId,
          ),
        )
        .toBe(index);
      await expectEditableMenuTarget(page, top, "");
    }
    expect(await readRawPtyInput(page)).toBe("");

    await page.keyboard.press("Escape");
    await expect(ptyInput(page)).not.toHaveAttribute("data-pty-context-menu");
    await expect.poll(() => readRawPtyInput(page)).toBe("\x1b");
    await page.keyboard.type("normal input");
    await expect.poll(() => readRawPtyInput(page)).toBe("\x1bnormal input");

    await openNativeMenuTarget(page, top);
    await ptyInput(page).dispatchEvent("compositionstart", { data: "" });
    await expect(ptyInput(page)).not.toHaveAttribute("data-pty-context-menu");
    await ptyInput(page).dispatchEvent("compositionend", { data: "" });
    expect(await readRawPtyInput(page)).toBe("\x1bnormal input");
  });
});
