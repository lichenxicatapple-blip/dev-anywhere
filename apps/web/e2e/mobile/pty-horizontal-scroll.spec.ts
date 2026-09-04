// 真 Android Chrome: 长 PTY 输入期间, 水平/纵向滚动都可能被浏览器输入法布局改写。
// 这些 case 保护输入区始终可见, 且 Enter 提交后能立刻回到行首。
import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import {
  expectPtyCursorAwareBottom,
  ptyInput,
  ptyTerminal,
  readPtyDebugSnapshot,
  readPtyHorizontalScrollMetrics,
  resizePty,
  sendPtyLines,
  sendPtyOutput,
} from "../pty-scroll-helpers";
import { touchPtyTerminalAndWaitForSoftKeyboard } from "./pty-soft-keyboard";

const SESSION_ID = "mobile-pty-horizontal-scroll";

async function touchDrag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    async ({ startPoint, endPoint }) => {
      const target = document.elementFromPoint(startPoint.x, startPoint.y);
      if (!(target instanceof Element)) throw new Error("touch drag target is missing");
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const makeTouch = (point: { x: number; y: number }) =>
        new Touch({
          identifier: 1,
          target,
          clientX: point.x,
          clientY: point.y,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        });
      const dispatch = (type: "touchstart" | "touchmove" | "touchend", point: Touch | null) => {
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: point && type !== "touchend" ? [point] : [],
            targetTouches: point && type !== "touchend" ? [point] : [],
            changedTouches: point ? [point] : [],
          }),
        );
      };

      dispatch("touchstart", makeTouch(startPoint));
      for (let step = 1; step <= 4; step += 1) {
        const progress = step / 4;
        await sleep(40);
        dispatch(
          "touchmove",
          makeTouch({
            x: startPoint.x + (endPoint.x - startPoint.x) * progress,
            y: startPoint.y + (endPoint.y - startPoint.y) * progress,
          }),
        );
      }
      await sleep(60);
      dispatch("touchend", makeTouch(endPoint));
    },
    { startPoint: start, endPoint: end },
  );
}

test.describe("L4 mobile / PTY input scroll", () => {
  test.setTimeout(60_000);

  test("keeps a local-terminal Shell session at its snapshot width after mobile reconnect", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-session-owned`;
    await setupPtyChat(emuPage, {
      sessionId,
      sessionKind: "terminal",
      provider: "claude",
      ptyOwner: "local-terminal",
      cols: 80,
      rows: 24,
      snapshotData: `${"QR".repeat(38)}\r\n$ `,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          const wrappedLines = Array.from(
            { length: term.buffer.active.length },
            (_, index) => term.buffer.active.getLine(index)?.isWrapped === true,
          ).filter(Boolean).length;
          return { cols: term.cols, rows: term.rows, wrappedLines };
        }, sessionId),
      )
      .toEqual({ cols: 80, rows: 24, wrappedLines: 0 });
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.maxScrollLeft))
      .toBeGreaterThan(100);

    const resizeRequests = await emuPage.evaluate(() =>
      window.__ptySmoke.sent.filter((raw) => {
        try {
          return (JSON.parse(raw) as { type?: string }).type === "terminal_resize_request";
        } catch {
          return false;
        }
      }),
    );
    expect(resizeRequests).toEqual([]);
  });

  test("keeps a visible restored cursor left-aligned until live output advances it", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-snapshot-lookahead`;
    await setupPtyChat(emuPage, {
      sessionId,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 270,
      rows: 52,
      snapshotData: "x".repeat(40),
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          const debug = window.__devAnywherePtyDebug?.();
          if (!term || !debug || debug.cell.w <= 0) return null;
          const cursorPx = term.buffer.active.cursorX * debug.cell.w;
          return {
            cursorX: term.buffer.active.cursorX,
            visible: cursorPx < debug.container.clientWidth,
            insideLookahead: cursorPx >= debug.container.clientWidth - 8 * debug.cell.w,
          };
        }, sessionId),
      )
      .toEqual({ cursorX: 40, visible: true, insideLookahead: true });
    await emuPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const restored = await readPtyHorizontalScrollMetrics(emuPage);
    expect(restored.maxScrollLeft).toBeGreaterThan(100);
    expect(restored.scrollLeft).toBeLessThanOrEqual(1);

    // Preserve the v0.5.21 behavior: once a real PTY frame advances the cursor inside the
    // right-side lookahead zone, follow early so mobile typing retains one tab stop of context.
    await sendPtyOutput(emuPage, "x");
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(1);
  });

  test("touch-drag pans horizontally when the PTY overflows the mobile viewport", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-touch-pan`;
    await emuPage.addInitScript(() => {
      localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
    });
    await setupPtyChat(emuPage, {
      sessionId,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 80, 24);
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.maxScrollLeft))
      .toBeGreaterThan(100);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    await touchDrag(
      emuPage,
      { x: box.x + box.width - 24, y: box.y + box.height * 0.55 },
      { x: box.x + 24, y: box.y + box.height * 0.55 },
    );

    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(80);
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__devAnywherePtyScrollTrace ?? []).some(
            (entry) => entry.event === "touchmove:horizontal-native",
          ),
        ),
      )
      .toBe(true);
  });

  test("keeps following the cursor after Chrome nudges scrollLeft while typing", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, {
      sessionId: `${SESSION_ID}-nudge`,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTestPtyTerminals?.get(sid)?.cols ?? 0,
          `${SESSION_ID}-nudge`,
        ),
      )
      .toBe(270);

    await ptyTerminal(emuPage).click();
    await expect(ptyInput(emuPage)).toBeFocused();
    await ptyTerminal(emuPage).evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollLeft = 28;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await sendPtyOutput(emuPage, "x".repeat(90));

    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(100);
  });

  test("starts following before the cursor reaches the mobile right edge", async ({ emuPage }) => {
    const sessionId = `${SESSION_ID}-right-edge-follow`;
    await setupPtyChat(emuPage, {
      sessionId,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 80, 24);
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.maxScrollLeft))
      .toBeGreaterThan(100);
    await sendPtyOutput(emuPage, "\r\u001b[2K");

    const before = await readPtyDebugSnapshot(emuPage);
    if (!before || before.cell.w <= 0) throw new Error("PTY debug geometry is not available");
    const triggerColumn = Math.ceil(before.container.clientWidth / before.cell.w - 8);
    expect(triggerColumn).toBeGreaterThan(1);

    await sendPtyOutput(emuPage, "x".repeat(triggerColumn - 1));
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeLessThanOrEqual(1);

    await sendPtyOutput(emuPage, "x");
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(1);

    const after = await readPtyDebugSnapshot(emuPage);
    if (!after) throw new Error("PTY debug snapshot is not available");
    expect(after.term.cursorX * after.cell.w).toBeLessThan(after.container.clientWidth);
  });

  test("resets horizontal scroll to line start after mobile-control Enter on a long line", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, {
      sessionId: SESSION_ID,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols ?? 0, SESSION_ID),
      )
      .toBe(270);

    await touchPtyTerminalAndWaitForSoftKeyboard(emuPage);

    await sendPtyOutput(emuPage, `LONG ${"x".repeat(140)}`);
    await expect
      .poll(() =>
        readPtyHorizontalScrollMetrics(emuPage).then(
          (metrics) => metrics.scrollWidth - metrics.clientWidth,
        ),
      )
      .toBeGreaterThan(400);
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeGreaterThan(0);
    await expect(ptyInput(emuPage)).toBeFocused();

    const enterControl = emuPage.getByRole("button", { name: "回车" });
    await expect(enterControl).toBeVisible();
    await enterControl.evaluate((button: HTMLButtonElement) => button.click());

    await expect.poll(() => readRawPtyInput(emuPage)).toContain("\r");
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(emuPage).then((metrics) => metrics.scrollLeft))
      .toBeLessThanOrEqual(1);
  });

  test("keeps vertical follow after raw input when Chrome reports a layout scroll", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-vertical-drift`;
    await setupPtyChat(emuPage, {
      sessionId,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await resizePty(emuPage, 270, 52);
    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0, sessionId),
      )
      .toBe(52);
    await sendPtyLines(emuPage, { count: 160, prefix: "fill" });

    await ptyTerminal(emuPage).click();
    await expect(ptyInput(emuPage)).toBeFocused();
    await emuPage.keyboard.type("x");
    await expect.poll(() => readRawPtyInput(emuPage)).toContain("x");
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((snapshot) => snapshot?.verticalIntent.mode))
      .toBe("following");

    await ptyTerminal(emuPage).evaluate((el) => {
      const node = el as HTMLElement;
      const bottom =
        window.__devAnywherePtyDebug?.()?.anchor.bottomScrollTop ??
        Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(0, bottom - 240);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((snapshot) => snapshot?.verticalIntent.mode))
      .toBe("following");
    await expectPtyCursorAwareBottom(emuPage);
  });
});
