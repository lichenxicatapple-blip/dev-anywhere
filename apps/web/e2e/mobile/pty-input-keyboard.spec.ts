// 移动端 PTY 输入路径 e2e (commit 1864a268 防回归):
// 1. cold-start 进会话 textarea 不该 auto-focus (避免触屏立刻弹软键盘),
// 2. 用户主动点 PTY 后才 focus,
// 3. focus 后基础输入 + Enter 落到 raw input.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import type { Page } from "@playwright/test";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";
import {
  dismissSoftKeyboard,
  setAndroidEmulatorOrientation,
  touchPtyTerminal,
  touchPtyTerminalAndWaitForSoftKeyboard,
  waitForSoftKeyboard,
} from "./pty-soft-keyboard";

const SESSION_ID = "mobile-pty-input";

async function readPtyCursorKeyboardClearance(page: Page, sessionId: string) {
  return page.evaluate((sid) => {
    const term = window.__ccTestPtyTerminals?.get(sid);
    const textarea = document.querySelector<HTMLElement>(
      '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
    );
    const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    const controls = document.querySelector<HTMLElement>('[data-slot="pty-mobile-controls"]');
    if (!term || !textarea || !screen || !controls) return null;

    const textareaRect = textarea.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const cellHeight = screenRect.height / Math.max(term.rows, 1);
    return {
      cursorTop: textareaRect.top,
      cursorBottom: textareaRect.top + cellHeight,
      controlsTop: controlsRect.top,
      clearance: controlsRect.top - (textareaRect.top + cellHeight),
      keyboardOffset: Number(
        document.querySelector("[data-keyboard-offset]")?.getAttribute("data-keyboard-offset") ??
          "0",
      ),
    };
  }, sessionId);
}

async function expectPtyCursorAboveKeyboard(page: Page, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () => (await readPtyCursorKeyboardClearance(page, sessionId))?.clearance ?? -Infinity,
      {
        timeout: 10_000,
        message: "PTY input cursor did not settle above the soft-keyboard controls",
      },
    )
    .toBeGreaterThanOrEqual(-2);
}

async function movePtyViewportAwayWhileKeyboardStaysOpen(
  page: Page,
  sessionId: string,
): Promise<void> {
  const terminal = page.locator('[data-slot="pty-terminal"]');
  await terminal.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = (element as HTMLElement).scrollTop;
        let stableFrames = 0;
        let remainingFrames = 10;
        const sample = () => {
          const current = (element as HTMLElement).scrollTop;
          stableFrames = Math.abs(current - previous) <= 1 ? stableFrames + 1 : 0;
          previous = current;
          remainingFrames -= 1;
          if (stableFrames >= 2 || remainingFrames <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  const before = await terminal.evaluate((element) => (element as HTMLElement).scrollTop);
  const clearance = await readPtyCursorKeyboardClearance(page, sessionId);
  const reviewDistance = Math.max(240, (clearance?.clearance ?? 0) + 80);
  await terminal.evaluate((element, distance) => {
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }),
    );
  }, reviewDistance);
  await expect
    .poll(() => terminal.evaluate((element) => (element as HTMLElement).scrollTop))
    .toBeLessThan(before - 100);
}

test.describe("L4 mobile / PTY input + soft keyboard discipline", () => {
  test.setTimeout(60_000);

  test.afterEach(async ({ emuPage }) => {
    await dismissSoftKeyboard(emuPage);
  });

  test("does not auto-focus terminal; tap focuses, sends input, and preserves IME punctuation", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    // cold-start: textarea 不应该自动 focus, 否则 Android 系统软键盘立刻弹起.
    const initialFocus = await emuPage.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    );
    expect(initialFocus).not.toBe("Terminal input");

    // 用户主动点 PTY 容器, textarea 才接管 focus.
    await touchPtyTerminal(emuPage);
    await expect
      .poll(() => emuPage.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");

    // 输入 + 回车. 移动端 PTY 走 touch-editing 路径, Enter 派 \n 而非 \r.
    await emuPage.keyboard.type("abc");
    await emuPage.keyboard.press("Enter");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("abc");

    const input = emuPage.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await expect(input).toBeFocused();

    await input.evaluate((el) => {
      el.dispatchEvent(
        new InputEvent("input", {
          data: "，",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("，");
  });

  test("raises the Android soft keyboard and keeps PTY controls above it", async ({ emuPage }) => {
    // setupPtyChat/terminal mount can consume up to 30s, while the native tap,
    // IME visibility, visual viewport and controls-settle checks have their own
    // bounded budgets. The describe-level 60s cap could kill the worker during
    // those documented waits and turn one timeout into a dead CDP connection.
    test.setTimeout(90_000);
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    const rowsBeforeFocus = await emuPage.evaluate(
      (sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0,
      SESSION_ID,
    );
    expect(rowsBeforeFocus).toBeGreaterThan(0);

    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);

    const metrics = await emuPage.evaluate((sid) => {
      const controls = document.querySelector('[data-slot="pty-mobile-controls"]');
      const controlsRect = controls?.getBoundingClientRect();
      const controlKeys = Array.from(
        controls?.querySelectorAll<HTMLElement>('button[data-slot^="pty-mobile-key-"]') ?? [],
      );
      const lowestKeyBottom =
        controlKeys.length > 0
          ? Math.max(...controlKeys.map((key) => key.getBoundingClientRect().bottom))
          : null;
      return {
        controlsBottom: controlsRect ? controlsRect.y + controlsRect.height : null,
        controlsHeight: controlsRect?.height ?? null,
        interactiveBottomClearance:
          controlsRect && lowestKeyBottom !== null ? controlsRect.bottom - lowestKeyBottom : null,
        terminalRows: window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0,
        keyboardOffset: Number(
          document.querySelector("[data-keyboard-offset]")?.getAttribute("data-keyboard-offset") ??
            "0",
        ),
        keyboardLayoutInset: Number(
          document
            .querySelector("[data-keyboard-layout-inset]")
            ?.getAttribute("data-keyboard-layout-inset") ?? "0",
        ),
        visualViewportTop: window.visualViewport?.offsetTop ?? 0,
        visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
      };
    }, SESSION_ID);

    expect(metrics.keyboardOffset).toBeGreaterThan(0);
    expect(metrics.terminalRows).toBe(rowsBeforeFocus);
    expect(metrics.controlsBottom).not.toBeNull();
    expect(metrics.controlsHeight).not.toBeNull();
    expect(metrics.controlsHeight ?? 0).toBeGreaterThan(80);
    expect(metrics.interactiveBottomClearance).not.toBeNull();
    expect(metrics.interactiveBottomClearance ?? 0).toBeGreaterThanOrEqual(23);
    const visualViewportBottom = metrics.visualViewportTop + metrics.visualViewportHeight;
    expect(metrics.controlsBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      visualViewportBottom + 2,
    );
    expect(visualViewportBottom - (metrics.controlsBottom ?? 0)).toBeLessThanOrEqual(24);

    const controlHeights: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) {
      controlHeights.push(
        await emuPage
          .locator('[data-slot="pty-mobile-controls"]')
          .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
      );
      await emuPage.waitForTimeout(100);
    }
    expect(new Set(controlHeights)).toEqual(new Set([Math.round(metrics.controlsHeight ?? 0)]));
  });

  test("keeps the input row visible on the first keyboard open while PTY output settles", async ({
    emuPage,
  }) => {
    // Two complete native IME open/close cycles. Hosted UIAutomator is several
    // times slower than local ADB, so preserve the helpers' bounded diagnostics
    // instead of killing their worker midway through the second cycle.
    test.setTimeout(180_000);
    const sessionId = `${SESSION_ID}-first-keyboard-open`;
    await dismissSoftKeyboard(emuPage);
    await setAndroidEmulatorOrientation(emuPage, "portrait");
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      rows: 52,
      cols: 80,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      let line = 0;
      const timer = window.setInterval(() => {
        window.__ptySmoke.sendPty(`first-open output ${String(line).padStart(3, "0")}\r\n`);
        line += 1;
        if (line >= 180) window.clearInterval(timer);
      }, 16);
    });

    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
    await expect
      .poll(
        () =>
          emuPage.evaluate(
            (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.baseY ?? 0,
            sessionId,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(100);
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);

    await dismissSoftKeyboard(emuPage);
    await emuPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);
  });

  test("keeps the live PTY input cursor visible across repeated soft-keyboard cycles", async ({
    emuPage,
  }) => {
    // Three complete native IME cycles, each with independently bounded native
    // visibility, web viewport and controls-settlement checks.
    test.setTimeout(240_000);
    const sessionId = `${SESSION_ID}-cursor-clearance`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      rows: 52,
      cols: 80,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 220 },
          (_, index) => `keyboard cursor line ${String(index).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(
        () =>
          emuPage.evaluate(
            (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.baseY ?? 0,
            sessionId,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
      await expectPtyCursorAboveKeyboard(emuPage, sessionId);

      await emuPage.keyboard.type(String(cycle));
      await expectPtyCursorAboveKeyboard(emuPage, sessionId);

      await dismissSoftKeyboard(emuPage);
      await emuPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect
        .poll(() =>
          emuPage.evaluate(() =>
            Number(
              document
                .querySelector("[data-keyboard-offset]")
                ?.getAttribute("data-keyboard-offset") ?? "0",
            ),
          ),
        )
        .toBe(0);
    }
  });

  test("returns to the live cursor when typing after keyboard-open history review", async ({
    emuPage,
  }) => {
    test.setTimeout(120_000);
    const sessionId = `${SESSION_ID}-review-then-type`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      rows: 52,
      cols: 80,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 220 },
          (_, index) => `keyboard review line ${String(index).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });

    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);
    await movePtyViewportAwayWhileKeyboardStaysOpen(emuPage, sessionId);
    await waitForSoftKeyboard(emuPage);
    await expect(emuPage.locator('[data-slot="pty-mobile-controls"]')).toBeVisible();
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          Number(
            document
              .querySelector("[data-keyboard-offset]")
              ?.getAttribute("data-keyboard-offset") ?? "0",
          ),
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () => (await readPtyCursorKeyboardClearance(emuPage, sessionId))?.clearance ?? 0,
        { message: "history review did not move the live cursor below the controls" },
      )
      .toBeLessThan(-20);

    await emuPage.keyboard.type("resume");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("resume");
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);
  });

  test("keeps one-row PTY controls clear of the Android keyboard in landscape", async ({
    emuPage,
  }) => {
    test.setTimeout(90_000);
    await setAndroidEmulatorOrientation(emuPage, "landscape");
    try {
      await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
      await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
      await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);

      const geometry = await emuPage.evaluate(() => {
        const controls = document.querySelector<HTMLElement>('[data-slot="pty-mobile-controls"]');
        const keys = Array.from(
          controls?.querySelectorAll<HTMLElement>('button[data-slot^="pty-mobile-key-"]') ?? [],
        );
        const rootRect = controls?.getBoundingClientRect();
        return {
          keyRows: new Set(keys.map((key) => Math.round(key.getBoundingClientRect().top))).size,
          interactiveBottomClearance:
            rootRect && keys.length > 0
              ? rootRect.bottom - Math.max(...keys.map((key) => key.getBoundingClientRect().bottom))
              : null,
        };
      });

      expect(geometry.keyRows).toBe(1);
      expect(geometry.interactiveBottomClearance).not.toBeNull();
      expect(geometry.interactiveBottomClearance ?? 0).toBeGreaterThanOrEqual(23);
    } finally {
      await dismissSoftKeyboard(emuPage);
      await setAndroidEmulatorOrientation(emuPage, "auto");
    }
  });
});
