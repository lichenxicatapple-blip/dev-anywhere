// PTY 输入相关 e2e: 基础按键, 移动端 on-screen controls, IME 全角符号.
import { expect, test } from "@playwright/test";
import { expectTouchTarget } from "../mobile-helpers";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-input";

test.describe("PTY input: keyboard, mobile soft controls, IME", () => {
  test("sends raw keystrokes and exposes touch-only on-screen keys when pointer is coarse", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });

    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="input-bar-region"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-connecting"]')).toHaveCount(0);
    await expectPtyTerminalMounted(page);
    await expect
      .poll(() =>
        page
          .locator('[data-slot="pty-terminal"]')
          .evaluate((el) => getComputedStyle(el).touchAction),
      )
      .toBe("pan-x pan-y");
    const touchEditingSurface = await page.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => readRawPtyInput(page))
      .toContain(touchEditingSurface ? "abc\n" : "abc\r");

    if (!touchEditingSurface) {
      await expect(page.locator('[data-slot="pty-mobile-controls"]')).toHaveCount(0);
      return;
    }

    const controls = page.locator('[data-slot="pty-mobile-controls"]');
    await expect(controls).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-clear"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-left"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-enter"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-tab"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-shift-tab"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-ctrl-t"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-esc"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-ctrl-c"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-ctrl-b"]'));
    await expectTouchTarget(page.locator('[data-slot="pty-mobile-key-ctrl-s"]'));
    await page.locator('[data-slot="pty-mobile-key-tab"]').click();
    await page.locator('[data-slot="pty-mobile-key-shift-tab"]').click();
    await page.locator('[data-slot="pty-mobile-key-ctrl-t"]').click();
    await page.locator('[data-slot="pty-mobile-key-esc"]').click();
    await page.locator('[data-slot="pty-mobile-key-ctrl-b"]').click();
    await page.locator('[data-slot="pty-mobile-key-ctrl-c"]').click();
    await page.locator('[data-slot="pty-mobile-key-clear"]').click();
    await page.locator('[data-slot="pty-mobile-key-ctrl-s"]').click();
    await page.locator('[data-slot="pty-mobile-key-left"]').click();
    await page.locator('[data-slot="pty-mobile-key-right"]').click();
    await page.locator('[data-slot="pty-mobile-key-up"]').click();
    await page.locator('[data-slot="pty-mobile-key-down"]').click();
    await page.locator('[data-slot="pty-mobile-key-enter"]').click();
    await expect
      .poll(() => readRawPtyInput(page))
      .toContain("abc\n\t\x1b[Z\x14\x1b\x02\x03\x1b\x1b\x13\x1b[D\x1b[C\x1b[A\x1b[B\r");

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );
    await expect(controls).toBeVisible();
    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: window.innerHeight,
        offsetTop: 0,
      }),
    );
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");
    await expect(controls).toHaveCount(0);

    await page
      .locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]')
      .evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(controls).toHaveCount(0);
  });

  test("preserves IME-transformed full-width punctuation in raw PTY input", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await input.focus();
    await input.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true }));
      el.dispatchEvent(
        new InputEvent("input", {
          data: "，",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });

    await expect.poll(() => readRawPtyInput(page)).toBe("，");

    await input.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true }));
      el.dispatchEvent(
        new InputEvent("input", {
          data: ".",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });

    await expect.poll(() => readRawPtyInput(page)).toBe("，.");
  });

  test("guards Codex mobile clear button from sending duplicate Ctrl+C on double tap", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: "pty-input-codex-clear",
      provider: "codex",
      withVisualViewportMock: true,
    });
    await expectPtyTerminalMounted(page);

    const touchEditingSurface = await page.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );
    if (!touchEditingSurface) return;

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await expect(page.locator('[data-slot="pty-mobile-controls"]')).toBeVisible();
    const clearButton = page.locator('[data-slot="pty-mobile-key-clear"]');
    await clearButton.click();
    await clearButton.click();

    await expect.poll(() => readRawPtyInput(page)).toBe("\x03");

    await page.locator('[data-slot="pty-mobile-key-ctrl-c"]').click();

    await expect.poll(() => readRawPtyInput(page)).toBe("\x03\x03");
  });
});
