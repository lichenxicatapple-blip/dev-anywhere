// 移动端 PTY 输入路径 e2e (commit 1864a268 防回归):
// 1. cold-start 进会话 textarea 不该 auto-focus (避免触屏立刻弹软键盘),
// 2. 用户主动点 PTY 后才 focus,
// 3. focus 后基础输入 + Enter 落到 raw input.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import type { Page } from "@playwright/test";
import { setupPtyChat, expectPtyTerminalMounted, readRawPtyInput } from "../pty-fixture";
import { expectPtyCursorAwareBottom } from "../pty-scroll-helpers";
import {
  dismissSoftKeyboard,
  setAndroidEmulatorDisplaySize,
  setAndroidEmulatorOrientation,
  swipeDownPtyToDismissSoftKeyboard,
  tapWithAdb,
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

async function readClosedPtyLiveTailGeometry(page: Page, sessionId: string) {
  return page.evaluate((sid) => {
    const term = window.__ccTestPtyTerminals?.get(sid);
    const terminal = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
    const screen = host?.querySelector<HTMLElement>(".xterm-screen");
    const backToBottom = document.querySelector<HTMLElement>('[data-slot="back-to-bottom"]');
    const reviewSnapshot = screen?.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    const reviewRows = reviewSnapshot?.querySelector<HTMLElement>(".xterm-rows");
    if (!term || !terminal || !host || !screen) return null;

    const buffer = term.buffer.active;
    let lastNonEmptyRow = -1;
    for (let row = term.rows - 1; row >= 0; row -= 1) {
      const line = buffer.getLine(buffer.baseY + row);
      if (line?.translateToString(true).trimEnd()) {
        lastNonEmptyRow = row;
        break;
      }
    }

    const style = getComputedStyle(terminal);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const hostStyle = getComputedStyle(host);
    const hostTop = Number.parseFloat(hostStyle.top) || 0;
    const hostPaddingTop = Number.parseFloat(hostStyle.paddingTop) || 0;
    const cellHeight = screen.getBoundingClientRect().height / Math.max(term.rows, 1);
    const liveTailRow = Math.max(buffer.cursorY, lastNonEmptyRow, 0);
    const liveTailBufferRow = buffer.baseY + liveTailRow;
    const liveTailViewportRow = liveTailBufferRow - buffer.viewportY;
    const liveTailBottom =
      paddingTop + hostTop + hostPaddingTop + (liveTailViewportRow + 1) * cellHeight;
    const visibleBottom = terminal.scrollTop + terminal.clientHeight - paddingBottom;
    const terminalRect = terminal.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const debug = window.__devAnywherePtyDebug?.();
    const visibleClientTop = terminalRect.top + paddingTop;
    const visibleClientBottom = terminalRect.top + terminal.clientHeight - paddingBottom;
    const renderedReviewRows = Array.from(reviewRows?.children ?? [])
      .filter((row): row is HTMLElement => row instanceof HTMLElement && Boolean(row.textContent))
      .map((row) => ({ text: row.textContent ?? "", rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > visibleClientTop && rect.top < visibleClientBottom);
    const reviewContentTop =
      renderedReviewRows.length > 0
        ? Math.min(...renderedReviewRows.map(({ rect }) => rect.top))
        : null;
    const reviewContentBottom =
      renderedReviewRows.length > 0
        ? Math.max(...renderedReviewRows.map(({ rect }) => rect.bottom))
        : null;

    return {
      blankBelowLiveTail: visibleBottom - liveTailBottom,
      cellHeight,
      cursorBufferRow: buffer.baseY + buffer.cursorY,
      cursorInViewport: debug?.anchor.cursorInViewport ?? false,
      keyboardOffset: Number(
        document.querySelector("[data-keyboard-offset]")?.getAttribute("data-keyboard-offset") ??
          "0",
      ),
      baseY: buffer.baseY,
      bottomScrollTop: debug?.anchor.bottomScrollTop ?? null,
      clientHeight: terminal.clientHeight,
      cursorY: buffer.cursorY,
      hostPaddingTop,
      hostHeight: hostRect.height,
      hostTop,
      liveTailViewportRow,
      pendingContainerSyncRetry: debug?.pendingContainerSyncRetry ?? null,
      backToBottomInert: backToBottom?.hasAttribute("inert") ?? false,
      backToBottomLabel: backToBottom?.getAttribute("aria-label") ?? null,
      backToBottomPointerEvents: backToBottom ? getComputedStyle(backToBottom).pointerEvents : null,
      reviewBlankAbove:
        reviewContentTop === null ? null : Math.max(0, reviewContentTop - visibleClientTop),
      reviewBlankBelow:
        reviewContentBottom === null
          ? null
          : Math.max(0, visibleClientBottom - reviewContentBottom),
      reviewContentBottom,
      reviewContentTop,
      reviewSnapshotPresent: Boolean(reviewSnapshot),
      reviewVisibleRowCount: renderedReviewRows.length,
      reviewVisibleText: renderedReviewRows.map(({ text }) => text).join("\n"),
      rows: term.rows,
      screenBottomDelta:
        terminalRect.top + terminal.clientHeight - paddingBottom - screenRect.bottom,
      scrollTop: terminal.scrollTop,
      scrollTopDeltaToBottom: debug?.anchor.scrollTopDeltaToBottom ?? null,
      semanticAtBottom: debug?.anchor.atBottom ?? false,
      verticalIntentMode: debug?.verticalIntent.mode ?? null,
      verticalIntentSource: debug?.verticalIntent.source ?? null,
      verticalIntentTransitionId: debug?.verticalIntent.transitionId ?? null,
      visibleClientBottom,
      visibleClientTop,
      visibleContentHeight: terminal.clientHeight - paddingTop - paddingBottom,
      viewportY: buffer.viewportY,
    };
  }, sessionId);
}

async function waitForPtyKeyboardGeometryToSettle(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    (sid) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        let previous = "";
        let stableFrames = 0;
        const sample = () => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          const terminal = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
          const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
          const screen = host?.querySelector<HTMLElement>(".xterm-screen");
          const reviewSnapshot = screen?.querySelector<HTMLElement>(
            '[data-slot="pty-review-snapshot"]',
          );
          const reviewRows = reviewSnapshot?.querySelector<HTMLElement>(".xterm-rows");
          const debug = window.__devAnywherePtyDebug?.();
          const viewport = window.visualViewport;
          if (term && terminal && host && screen && debug) {
            const current = JSON.stringify({
              scrollTop: terminal.scrollTop,
              clientHeight: terminal.clientHeight,
              hostTop: getComputedStyle(host).top,
              hostPaddingTop: getComputedStyle(host).paddingTop,
              screenTop: screen.getBoundingClientRect().top,
              reviewSnapshotTop: reviewSnapshot?.getBoundingClientRect().top ?? null,
              reviewSnapshotHeight: reviewSnapshot?.getBoundingClientRect().height ?? null,
              reviewRowCount: reviewRows?.childElementCount ?? 0,
              viewportY: term.buffer.active.viewportY,
              keyboardOffset: document
                .querySelector("[data-keyboard-offset]")
                ?.getAttribute("data-keyboard-offset"),
              viewportHeight: viewport?.height ?? window.innerHeight,
              viewportTop: viewport?.offsetTop ?? 0,
              pendingContainerSyncRetry: debug.pendingContainerSyncRetry,
            });
            stableFrames = current === previous ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 4) {
              resolve();
              return;
            }
          }
          if (performance.now() >= deadline) {
            reject(new Error("PTY keyboard-close geometry did not settle"));
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    sessionId,
  );
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
    test.setTimeout(90_000);
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
    test.setTimeout(120_000);
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

  test("keeps keyboard-dismiss history review filled, frozen, and explicitly resumable", async ({
    emuPage,
  }, testInfo) => {
    test.setTimeout(90_000);
    const sessionId = `${SESSION_ID}-keyboard-close-tail`;
    try {
      // Reproduce the user's full-height Android Chrome viewport. The fixed 25-row,
      // approximately 20px-cell xterm becomes shorter than the keyboard-closed viewport.
      // Do not pin this to a Gboard pixel height: keyboard suggestions/toolbars can change the
      // reported occlusion while the product invariant is the newly visible PTY content area.
      await setAndroidEmulatorDisplaySize(emuPage, "baseline");
      await setupPtyChat(emuPage, {
        sessionId,
        baseUrl: mobileBaseUrl,
        provider: "codex",
        rows: 25,
        cols: 80,
      });
      await emuPage.evaluate(() => {
        localStorage.setItem("dev_anywhere_ptyFontSize", "17");
        localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
      });
      await emuPage.reload();
      await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
      await emuPage.evaluate(() => {
        window.__ptySmoke.sendPty(
          Array.from(
            { length: 225 },
            (_, index) => `keyboard close history ${String(index).padStart(3, "0")}\r\n`,
          ).join(""),
        );
      });
      await expect
        .poll(() =>
          emuPage.evaluate((sid) => {
            const buffer = window.__ccTestPtyTerminals?.get(sid)?.buffer.active;
            return buffer ? { baseY: buffer.baseY, cursorY: buffer.cursorY } : null;
          }, sessionId),
        )
        .toEqual({ baseY: 202, cursorY: 24 });

      await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);
      await waitForPtyKeyboardGeometryToSettle(emuPage, sessionId);
      const opened = await readClosedPtyLiveTailGeometry(emuPage, sessionId);

      // This is the user's actual interaction. Do not use Android Back or DOM blur here: a
      // single native swipe starts on xterm, travels downward, and lets the IME close itself.
      const gestureTraceStart = await emuPage.evaluate(
        () => window.__devAnywherePtyScrollTrace?.length ?? 0,
      );
      const gesture = await swipeDownPtyToDismissSoftKeyboard(emuPage);
      await waitForPtyKeyboardGeometryToSettle(emuPage, sessionId);
      const closed = await readClosedPtyLiveTailGeometry(emuPage, sessionId);

      const reviewMarker = "keyboard review remains frozen";
      await emuPage.evaluate((marker) => {
        window.__ptySmoke.sendPty(`${marker}\r\n`);
      }, reviewMarker);
      await expect
        .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
        .toContain(reviewMarker);
      await waitForPtyKeyboardGeometryToSettle(emuPage, sessionId);
      const afterOutput = await readClosedPtyLiveTailGeometry(emuPage, sessionId);

      const backToBottom = emuPage.locator('[data-slot="back-to-bottom"]');
      await tapWithAdb(backToBottom);
      await waitForPtyKeyboardGeometryToSettle(emuPage, sessionId);
      const returned = await readClosedPtyLiveTailGeometry(emuPage, sessionId);
      const trace = await emuPage.evaluate(() => window.__devAnywherePtyScrollTrace ?? []);
      const gestureTrace = trace.slice(gestureTraceStart);

      await testInfo.attach("pty-downward-keyboard-dismiss.json", {
        body: Buffer.from(
          JSON.stringify(
            { gesture, opened, closed, afterOutput, returned, gestureTrace, trace },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      await testInfo.attach("pty-downward-keyboard-dismiss.png", {
        body: await emuPage.screenshot(),
        contentType: "image/png",
      });

      expect(opened).not.toBeNull();
      expect(opened?.rows).toBe(25);
      expect(opened?.baseY).toBe(202);
      expect(opened?.cursorY).toBe(24);
      expect(opened?.cellHeight ?? 0).toBeGreaterThanOrEqual(17);
      expect(opened?.cellHeight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(21);
      expect(opened?.keyboardOffset ?? 0).toBeGreaterThan(0);
      expect(opened?.verticalIntentMode).toBe("following");
      expect(opened?.semanticAtBottom).toBe(true);
      expect(Math.abs(opened?.scrollTopDeltaToBottom ?? Infinity)).toBeLessThanOrEqual(8);

      expect(gesture.native.endY).toBeGreaterThan(gesture.native.startY);
      expect(gestureTrace.some((entry) => entry.event === "touchstart")).toBe(true);
      expect(gestureTrace.some((entry) => entry.event === "touchmove")).toBe(true);

      expect(closed).not.toBeNull();
      expect(closed?.keyboardOffset).toBe(0);
      expect(closed?.rows).toBe(25);
      expect(closed?.baseY).toBe(202);
      expect(closed?.cursorY).toBe(24);
      expect(
        (closed?.visibleContentHeight ?? 0) - (opened?.visibleContentHeight ?? Infinity),
      ).toBeGreaterThanOrEqual(opened?.cellHeight ?? Infinity);
      expect(closed?.hostHeight ?? Infinity).toBeLessThan(closed?.visibleContentHeight ?? 0);
      expect(closed?.verticalIntentMode).toBe("reviewing");
      expect(closed?.verticalIntentSource).toBe("touch");
      expect(closed?.semanticAtBottom).toBe(false);
      expect(closed?.viewportY ?? Infinity).toBeLessThan(closed?.baseY ?? 0);
      expect(closed?.pendingContainerSyncRetry).toBe(false);
      expect(closed?.backToBottomInert).toBe(false);
      expect(closed?.backToBottomPointerEvents).toBe("auto");
      expect(closed?.reviewSnapshotPresent).toBe(true);
      // Fractional native scroll can cut through one terminal row on either edge. A gap smaller
      // than one cell is a partial row; the field bug leaves many complete rows uncovered. Check
      // both edges of the entire closed viewport, not only the strip newly released by the IME.
      expect(closed?.reviewBlankAbove ?? Infinity).toBeLessThan(closed?.cellHeight ?? 0);
      expect(closed?.reviewBlankBelow ?? Infinity).toBeLessThan(closed?.cellHeight ?? 0);
      expect(closed?.reviewVisibleRowCount ?? 0).toBeGreaterThanOrEqual(
        Math.ceil((closed?.visibleContentHeight ?? Infinity) / (closed?.cellHeight ?? 1)),
      );
      expect(closed?.reviewContentTop ?? Infinity).toBeLessThanOrEqual(
        (closed?.visibleClientTop ?? -Infinity) + (closed?.cellHeight ?? 0),
      );
      expect(closed?.reviewContentBottom ?? -Infinity).toBeGreaterThanOrEqual(
        (closed?.visibleClientBottom ?? Infinity) - (closed?.cellHeight ?? 0),
      );

      expect(afterOutput).not.toBeNull();
      expect(afterOutput?.verticalIntentMode).toBe("reviewing");
      expect(afterOutput?.viewportY).toBe(closed?.viewportY);
      expect(afterOutput?.scrollTop).toBeCloseTo(closed?.scrollTop ?? Infinity, 0);
      expect(afterOutput?.reviewVisibleText).toBe(closed?.reviewVisibleText);
      expect(afterOutput?.backToBottomLabel).toBe("回到最新");

      expect(returned).not.toBeNull();
      expect(returned?.verticalIntentMode).toBe("following");
      expect(returned?.semanticAtBottom).toBe(true);
      expect(returned?.cursorInViewport).toBe(true);
      expect(returned?.pendingContainerSyncRetry).toBe(false);
      expect(returned?.backToBottomInert).toBe(true);
      expect(returned?.backToBottomPointerEvents).toBe("none");
      expect(returned?.reviewSnapshotPresent).toBe(false);
      expect(Math.abs(returned?.scrollTopDeltaToBottom ?? Infinity)).toBeLessThanOrEqual(8);
      expect(returned?.blankBelowLiveTail ?? Infinity).toBeLessThanOrEqual(2);
      expect(returned?.screenBottomDelta ?? Infinity).toBeLessThanOrEqual(2);
    } catch (error) {
      const failureGeometry = await readClosedPtyLiveTailGeometry(emuPage, sessionId).catch(
        () => null,
      );
      const failureTrace = await emuPage
        .evaluate(() => window.__devAnywherePtyScrollTrace ?? [])
        .catch(() => []);
      await testInfo.attach("pty-downward-keyboard-dismiss-failure.json", {
        body: Buffer.from(JSON.stringify({ failureGeometry, failureTrace }, null, 2)),
        contentType: "application/json",
      });
      const screenshot = await emuPage.screenshot().catch(() => null);
      if (screenshot) {
        await testInfo.attach("pty-downward-keyboard-dismiss-failure.png", {
          body: screenshot,
          contentType: "image/png",
        });
      }
      throw error;
    } finally {
      // `wm size` is process-global for the emulator. Always return the shared device to the
      // 1080x2400 / density-420 / auto-portrait baseline, even when the assertion fails.
      await setAndroidEmulatorDisplaySize(emuPage, "baseline");
    }
  });

  test("returns to the live cursor when typing after keyboard-open history review", async ({
    emuPage,
  }) => {
    test.setTimeout(90_000);
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
    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    const backToBottom = emuPage.locator('[data-slot="back-to-bottom"]');
    await expect(reviewSnapshot).toBeVisible();
    await expect(backToBottom).toHaveJSProperty("inert", false);
    await expect
      .poll(
        async () => {
          const state = await readClosedPtyLiveTailGeometry(emuPage, sessionId);
          return {
            mode: state?.verticalIntentMode,
            reviewSnapshotPresent: state?.reviewSnapshotPresent,
          };
        },
        { message: "keyboard-open history review did not become visibly reviewable" },
      )
      .toEqual({
        mode: "reviewing",
        reviewSnapshotPresent: true,
      });
    await expect
      .poll(
        async () =>
          (await readClosedPtyLiveTailGeometry(emuPage, sessionId))?.scrollTopDeltaToBottom ?? 0,
      )
      .toBeLessThan(-20);

    await emuPage.keyboard.type("resume");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("resume");
    await expect(reviewSnapshot).toHaveCount(0);
    await expect(backToBottom).toHaveJSProperty("inert", true);
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);

    // Raw input must not merely jump to the current bottom once. Every later agent frame must
    // remain live-following; a stale page/review restore used to re-freeze the viewport here.
    await emuPage.evaluate(async () => {
      for (let index = 0; index < 12; index += 1) {
        window.__ptySmoke.sendPty(`continued agent frame ${index}\r\n`);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await expectPtyCursorAwareBottom(emuPage);
    await expectPtyCursorAboveKeyboard(emuPage, sessionId);
  });

  test("keeps one-row PTY controls clear of the Android keyboard in landscape", async ({
    emuPage,
  }) => {
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
