// 真 Android emu 上 PTY 模式滚动 + back-to-bottom 触屏交互:
// 1. 灌长 buffer 后滚到顶, back-to-bottom 出现, tap 后回底,
// 2. 滚到上方 (远离 bottom) 期间新输出不抢回底, "有新消息" 浮起.
import type { Locator, Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  enterLongHostMode,
  expectPtyCursorAwareBottom,
  expectPtyScrollable,
  ptyTerminal,
  readPtyDebugSnapshot,
  readPtyScrollMetrics,
  scrollPtyToTop,
  sendPtyLines,
  sendPtyOutput,
} from "../pty-scroll-helpers";

const SESSION_ID = "mobile-pty-scroll";

async function touchTap(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("tap target is not visible");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(60);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

async function touchDrag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    for (let step = 1; step <= 4; step += 1) {
      const progress = step / 4;
      await page.waitForTimeout(40);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          },
        ],
      });
    }
    await page.waitForTimeout(60);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach();
  }
}

async function touchFlick(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    for (let step = 1; step <= 3; step += 1) {
      const progress = step / 3;
      await page.waitForTimeout(12);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          },
        ],
      });
    }
    await page.waitForTimeout(12);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach();
  }
}

interface ReviewScrollSample {
  scrollTop: number;
  viewportY: number;
  intentMode: string;
  intentSource: string;
  intentTransition: string;
  touchActive: boolean;
  hostTopDrift: number;
  renderedLine: number | null;
  renderedLineContentTop: number | null;
  renderedLineViewportTop: number | null;
  renderedRowHeight: number | null;
  renderedBottomGap: number | null;
}

async function startReviewScrollSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __ptyReviewScrollSamples?: ReviewScrollSample[];
      __ptyReviewScrollSampling?: boolean;
      __ptyReviewScrollListener?: () => void;
    };
    testWindow.__ptyReviewScrollSamples = [];
    testWindow.__ptyReviewScrollSampling = true;
    const sample = () => {
      if (!testWindow.__ptyReviewScrollSampling) return;
      const snapshot = window.__devAnywherePtyDebug?.();
      const scrollContainer = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
      if (snapshot && scrollContainer) {
        const frozenRows = document.querySelector<HTMLElement>(
          '[data-slot="pty-review-snapshot"] .xterm-rows',
        );
        const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
        const liveRows =
          screen &&
          Array.from(screen.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.classList.contains("xterm-rows"),
          );
        const rows = frozenRows ?? liveRows ?? null;
        let renderedLine: number | null = null;
        let renderedLineContentTop: number | null = null;
        let renderedLineViewportTop: number | null = null;
        let renderedRowHeight: number | null = null;
        let renderedBottomGap: number | null = null;
        if (rows) {
          const containerRect = scrollContainer.getBoundingClientRect();
          const paddingBottom =
            Number.parseFloat(getComputedStyle(scrollContainer).paddingBottom) || 0;
          renderedBottomGap = Math.max(
            0,
            containerRect.bottom - paddingBottom - rows.getBoundingClientRect().bottom,
          );
          for (const row of Array.from(rows.children)) {
            const match = row.textContent?.match(/(?:rapid-review|visible-live-tail)\s+(\d+)/);
            if (!match) continue;
            renderedLine = Number.parseInt(match[1], 10);
            const rowRect = row.getBoundingClientRect();
            renderedLineContentTop = rowRect.top - containerRect.top + snapshot.container.scrollTop;
            renderedLineViewportTop = rowRect.top - containerRect.top;
            renderedRowHeight = rowRect.height;
            break;
          }
        }
        testWindow.__ptyReviewScrollSamples?.push({
          scrollTop: snapshot.container.scrollTop,
          viewportY: snapshot.term.viewportY,
          intentMode: snapshot.verticalIntent.mode,
          intentSource: snapshot.verticalIntent.source,
          intentTransition: snapshot.verticalIntent.transitionId,
          touchActive: snapshot.touchScrollActive,
          hostTopDrift: snapshot.host.topDrift,
          renderedLine,
          renderedLineContentTop,
          renderedLineViewportTop,
          renderedRowHeight,
          renderedBottomGap,
        });
      }
    };
    const sampleFrame = () => {
      if (!testWindow.__ptyReviewScrollSampling) return;
      sample();
      requestAnimationFrame(sampleFrame);
    };
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const onScroll = () => sample();
    testWindow.__ptyReviewScrollListener = onScroll;
    container?.addEventListener("scroll", onScroll);
    requestAnimationFrame(sampleFrame);
  });
}

async function stopReviewScrollSampling(page: Page): Promise<ReviewScrollSample[]> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __ptyReviewScrollSamples?: ReviewScrollSample[];
      __ptyReviewScrollSampling?: boolean;
      __ptyReviewScrollListener?: () => void;
    };
    testWindow.__ptyReviewScrollSampling = false;
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    if (testWindow.__ptyReviewScrollListener) {
      container?.removeEventListener("scroll", testWindow.__ptyReviewScrollListener);
      testWindow.__ptyReviewScrollListener = undefined;
    }
    return testWindow.__ptyReviewScrollSamples ?? [];
  });
}

function expectReviewScrollSamplesStable(
  samples: ReviewScrollSample[],
  options: { minimumScrollRange: number },
): void {
  const maxHostTopDrift = Math.max(...samples.map((sample) => Math.abs(sample.hostTopDrift)));
  const renderedSamples = samples.filter(
    (
      sample,
    ): sample is ReviewScrollSample & {
      renderedLine: number;
      renderedLineContentTop: number;
      renderedRowHeight: number;
    } =>
      sample.renderedLine !== null &&
      sample.renderedLineContentTop !== null &&
      sample.renderedRowHeight !== null,
  );
  const baseline = renderedSamples[0];
  if (!baseline) throw new Error("PTY rendered row samples are not available");
  const maxRenderedGeometryDriftRows = Math.max(
    ...renderedSamples.map((sample) =>
      Math.abs(
        (sample.renderedLineContentTop - baseline.renderedLineContentTop) /
          baseline.renderedRowHeight -
          (sample.renderedLine - baseline.renderedLine),
      ),
    ),
  );
  const scrollRange =
    Math.max(...samples.map((sample) => sample.scrollTop)) -
    Math.min(...samples.map((sample) => sample.scrollTop));
  const maxRenderedRowHeight = Math.max(
    ...renderedSamples.map((sample) => sample.renderedRowHeight),
  );
  const maxRenderedBottomGap = Math.max(...samples.map((sample) => sample.renderedBottomGap ?? 0));

  expect(samples.length).toBeGreaterThan(10);
  expect(scrollRange).toBeGreaterThan(options.minimumScrollRange);
  expect(maxHostTopDrift).toBeLessThanOrEqual(maxRenderedRowHeight + 1);
  // The frozen snapshot starts at the first physically visible buffer row, while xterm keeps a
  // separate fixed-size viewport that covers the visible bottom edge. Their row indices are not
  // expected to share a constant offset; physical line/content continuity below is the invariant.
  expect(maxRenderedGeometryDriftRows).toBeLessThanOrEqual(0.05);
  expect(maxRenderedBottomGap).toBeLessThanOrEqual(8);
}

function expectViewportNeverPulledTowardBottom(samples: ReviewScrollSample[]): void {
  const viewportMoves = samples
    .slice(1)
    .map((sample, index) => sample.viewportY - samples[index].viewportY);
  expect(samples.length).toBeGreaterThan(10);
  expect(Math.min(...samples.map((sample) => sample.viewportY))).toBeLessThan(samples[0].viewportY);
  const upwardMoves = samples
    .slice(1)
    .map((sample, index) => ({ previous: samples[index], sample }))
    .filter(({ previous, sample }) => sample.viewportY > previous.viewportY);
  expect(Math.max(...viewportMoves), JSON.stringify(upwardMoves, null, 2)).toBeLessThanOrEqual(0);
}

function expectReviewedFrameFrozen(samples: ReviewScrollSample[]): void {
  const renderedSamples = samples.filter(
    (
      sample,
    ): sample is ReviewScrollSample & {
      renderedLine: number;
      renderedLineViewportTop: number;
    } => sample.renderedLine !== null && sample.renderedLineViewportTop !== null,
  );
  const baseline = renderedSamples[0];
  if (!baseline) throw new Error("PTY reviewed frame samples are not available");

  expect(renderedSamples.length).toBeGreaterThan(10);
  expect(new Set(renderedSamples.map((sample) => sample.renderedLine))).toEqual(
    new Set([baseline.renderedLine]),
  );
  const maxViewportDrift = Math.max(
    ...renderedSamples.map((sample) =>
      Math.abs(sample.renderedLineViewportTop - baseline.renderedLineViewportTop),
    ),
  );
  expect(maxViewportDrift).toBeLessThanOrEqual(1);
}

async function readPtyScreenBottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    if (!container || !screen) return Number.POSITIVE_INFINITY;
    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const paddingBottom = Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
    return containerRect.bottom - paddingBottom - screenRect.bottom;
  });
}

async function readPtyLiveTopCoverage(page: Page): Promise<{
  rawLiveTopGap: number;
  paintedTopGap: number;
  backfillToScreenGap: number | null;
  backfillText: string;
}> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    const backfill = screen?.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    if (!container || !screen) {
      return {
        rawLiveTopGap: Number.POSITIVE_INFINITY,
        paintedTopGap: Number.POSITIVE_INFINITY,
        backfillToScreenGap: null,
        backfillText: "",
      };
    }
    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const paddingTop = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
    const contentTop = containerRect.top + paddingTop;
    const backfillRect = backfill?.getBoundingClientRect() ?? null;
    return {
      rawLiveTopGap: screenRect.top - contentTop,
      paintedTopGap: Math.max(
        0,
        Math.min(screenRect.top, backfillRect?.top ?? screenRect.top) - contentTop,
      ),
      backfillToScreenGap: backfillRect ? screenRect.top - backfillRect.bottom : null,
      backfillText: backfill?.textContent ?? "",
    };
  });
}

test.describe("L4 mobile / PTY scroll back-to-bottom", () => {
  test.setTimeout(60_000);

  test("PTY screen covers the mobile scroll viewport without a full-row bottom blank", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyCursorAwareBottom(emuPage);

    await expect.poll(() => readPtyScreenBottomGap(emuPage)).toBeLessThanOrEqual(8);
  });

  test("an extra bottom swipe keeps a short live host filled from preceding scrollback", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-short-live-backfill`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      provider: "codex",
      rows: 25,
      cols: 122,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await sendPtyLines(emuPage, { count: 225, prefix: "short-live-history" });
    await expectPtyCursorAwareBottom(emuPage);

    // The binary frame reaches the page before xterm finishes parsing all 225 rows. The semantic
    // bottom can therefore be valid for an intermediate buffer one task before the derived live
    // backfill is mounted. Wait for that rendered layer itself; all geometry assertions below
    // remain strict and still fail if it is misplaced or leaves a visible gap.
    await expect
      .poll(() => readPtyLiveTopCoverage(emuPage).then((coverage) => coverage.backfillToScreenGap))
      .not.toBeNull();
    const before = await readPtyLiveTopCoverage(emuPage);
    expect(before.rawLiveTopGap).toBeGreaterThan(80);
    expect(before.paintedTopGap).toBeLessThanOrEqual(1);
    expect(Math.abs(before.backfillToScreenGap ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
    expect(before.backfillText).toContain("short-live-history");

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    const startY = box.y + box.height * 0.72;
    await touchDrag(emuPage, { x, y: startY }, { x, y: startY - 175 });

    await expect
      .poll(async () => {
        const snapshot = await readPtyDebugSnapshot(emuPage);
        return {
          atBottom: snapshot?.anchor.atBottom,
          mode: snapshot?.verticalIntent.mode,
          reviewSnapshotCount: await emuPage.locator('[data-slot="pty-review-snapshot"]').count(),
        };
      })
      .toEqual({ atBottom: true, mode: "following", reviewSnapshotCount: 0 });
    await expect
      .poll(() => readPtyLiveTopCoverage(emuPage))
      .toEqual(
        expect.objectContaining({
          paintedTopGap: expect.any(Number),
          backfillText: expect.stringContaining("short-live-history"),
        }),
      );
    const after = await readPtyLiveTopCoverage(emuPage);
    expect(after.paintedTopGap).toBeLessThanOrEqual(1);
    expect(Math.abs(after.backfillToScreenGap ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
  });

  test("scroll up shows back-to-bottom; tap returns to bottom", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyScrollable(emuPage, 200);

    await scrollPtyToTop(emuPage);
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);

    const button = backToBottom(emuPage);
    await expect(button).toBeVisible();
    await expect(button).toHaveJSProperty("inert", false);

    await touchTap(emuPage, button);
    await expectPtyCursorAwareBottom(emuPage);
    await expect(button).toHaveJSProperty("inert", true);
  });

  test("small upward touch at semantic bottom does not jump to previous page", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-bottom-touch-drift`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 120, rows: 54 });
    await sendPtyLines(emuPage, { count: 260, prefix: "bottom-drift" });
    await expectPtyCursorAwareBottom(emuPage);
    const beforeSnapshot = await readPtyDebugSnapshot(emuPage);
    if (!beforeSnapshot) throw new Error("PTY debug snapshot is not available");

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await touchDrag(emuPage, { x, y }, { x, y: y - 36 });

    await expectPtyCursorAwareBottom(emuPage, 12);
    const afterSnapshot = await readPtyDebugSnapshot(emuPage);
    if (!afterSnapshot) throw new Error("PTY debug snapshot is not available");
    expect(afterSnapshot.container.scrollTop).toBeGreaterThanOrEqual(
      beforeSnapshot.container.scrollTop - 32,
    );

    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(reviewSnapshot).toHaveCount(0);
    await sendPtyOutput(
      emuPage,
      "\u001b7\u001b[20;1HWORKING elapsed 02s                              \u001b8",
    );
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("WORKING elapsed 02s");
    await expect
      .poll(() =>
        emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows').textContent(),
      )
      .toContain("WORKING elapsed 02s");
  });

  test("shallow review keeps the visible frame frozen while live output continues", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-visible-live-tail`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 120, rows: 54 });
    await sendPtyLines(emuPage, { count: 260, prefix: "visible-live-tail" });
    await expectPtyCursorAwareBottom(emuPage);

    await ptyTerminal(emuPage).evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, cancelable: true }));
    });

    await expect
      .poll(async () => {
        const snapshot = await readPtyDebugSnapshot(emuPage);
        return {
          mode: snapshot?.verticalIntent.mode,
          cursorInViewport: snapshot?.anchor.cursorInViewport,
        };
      })
      .toEqual({ mode: "reviewing", cursorInViewport: true });

    const beforeUpdate = await readPtyDebugSnapshot(emuPage);
    if (!beforeUpdate) throw new Error("PTY debug snapshot is not available");
    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(reviewSnapshot).toBeVisible();
    const frozenText = await reviewSnapshot.textContent();
    const frozenBox = await reviewSnapshot.boundingBox();
    const frozenFirstLine = Number(
      frozenText?.match(/visible-live-tail\s+(\d+)/)?.[1] ?? Number.NaN,
    );
    expect(frozenFirstLine).not.toBeNaN();

    await startReviewScrollSampling(emuPage);

    await sendPtyOutput(
      emuPage,
      "\u001b7\u001b[1A\rWORKING elapsed 03s                              \u001b8",
    );
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("WORKING elapsed 03s");
    await expect(reviewSnapshot).toContainText("WORKING elapsed 03s");

    for (let index = 1; index <= 12; index += 1) {
      await sendPtyOutput(emuPage, `visible-tail-append ${String(index).padStart(2, "0")}\r\n`);
      await emuPage.waitForTimeout(50);
    }
    await expect
      .poll(
        () =>
          emuPage.evaluate(
            () =>
              (
                window as typeof window & {
                  __ptyReviewScrollSamples?: ReviewScrollSample[];
                }
              ).__ptyReviewScrollSamples?.filter(
                (sample) => sample.renderedLine !== null && sample.renderedLineViewportTop !== null,
              ).length ?? 0,
          ),
        {
          timeout: 10_000,
          message: "PTY frozen review did not produce enough rendered frame samples",
        },
      )
      .toBeGreaterThan(10);
    const reviewSamples = await stopReviewScrollSampling(emuPage);
    expectReviewedFrameFrozen(reviewSamples);
    expect(await reviewSnapshot.boundingBox()).toEqual(frozenBox);

    const afterUpdate = await readPtyDebugSnapshot(emuPage);
    if (!afterUpdate) throw new Error("PTY debug snapshot is not available");
    expect(afterUpdate.container.scrollTop).toBeCloseTo(beforeUpdate.container.scrollTop, 0);
    expect(afterUpdate.verticalIntent.mode).toBe("reviewing");

    await ptyTerminal(emuPage).evaluate((element, deltaY) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));
    }, -Math.ceil(beforeUpdate.cell.h));
    await expect
      .poll(async () => {
        const text = (await reviewSnapshot.textContent()) ?? "";
        return Number(text.match(/visible-live-tail\s+(\d+)/)?.[1] ?? Number.NaN);
      })
      .toBe(frozenFirstLine - 1);
  });

  test("fast upward flick keeps host geometry aligned with the xterm viewport", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-rapid-review`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      sessionKind: "terminal",
      ptyOwner: "proxy-hosted",
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 122, rows: 29 });
    await sendPtyLines(emuPage, { count: 394, prefix: "rapid-review" });
    await expectPtyCursorAwareBottom(emuPage);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    await startReviewScrollSampling(emuPage);
    await touchFlick(
      emuPage,
      { x, y: box.y + box.height * 0.22 },
      { x, y: box.y + box.height * 0.78 },
    );
    await emuPage.waitForTimeout(700);
    const samples = await stopReviewScrollSampling(emuPage);

    expectReviewScrollSamplesStable(samples, { minimumScrollRange: 100 });
  });

  test("ordinary upward drag keeps a newly created PTY fully painted", async ({ emuPage }) => {
    const sessionId = `${SESSION_ID}-ordinary-review`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      sessionKind: "terminal",
      ptyOwner: "proxy-hosted",
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 122, rows: 29 });
    await sendPtyLines(emuPage, { count: 394, prefix: "rapid-review" });
    await expectPtyCursorAwareBottom(emuPage);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    await startReviewScrollSampling(emuPage);
    await touchDrag(
      emuPage,
      { x, y: box.y + box.height * 0.3 },
      { x, y: box.y + box.height * 0.68 },
    );
    await emuPage.waitForTimeout(500);
    const samples = await stopReviewScrollSampling(emuPage);

    expectReviewScrollSamplesStable(samples, { minimumScrollRange: 60 });
  });

  test("slow upward review is never pulled one row back by pending output", async ({ emuPage }) => {
    const sessionId = `${SESSION_ID}-slow-review-pending-output`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
      sessionKind: "terminal",
      ptyOwner: "proxy-hosted",
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 80, rows: 29 });
    await sendPtyLines(emuPage, { count: 5_029, prefix: "slow-review" });
    await expectPtyCursorAwareBottom(emuPage);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    const startY = box.y + box.height * 0.46;
    const client = await emuPage.context().newCDPSession(emuPage);
    await startReviewScrollSampling(emuPage);
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y: startY, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
      });
      for (const [index, distance] of [5, 10, 15, 22, 30, 38].entries()) {
        await emuPage.waitForTimeout(45);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: startY + distance, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
        });
        await sendPtyOutput(
          emuPage,
          `\u001b7\u001b[1A\rWORKING slow ${String(index).padStart(2, "0")}s                  \u001b8`,
        );
      }
      await emuPage.waitForTimeout(80);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await emuPage.waitForTimeout(250);
    } finally {
      await client.detach();
    }
    const samples = await stopReviewScrollSampling(emuPage);

    expectViewportNeverPulledTowardBottom(samples);
    const snapshot = await readPtyDebugSnapshot(emuPage);
    expect(snapshot?.verticalIntent.mode).toBe("reviewing");
  });

  test("new PTY output while scrolled up surfaces 有新消息 indicator without snapping to bottom", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyScrollable(emuPage, 200);

    await scrollPtyToTop(emuPage);
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);
    await expect(backToBottom(emuPage)).toBeVisible();
    const beforeScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;

    await sendPtyOutput(emuPage, "frame-while-user-scrolled-up\r\n");

    await expect(backToBottomNewIndicator(emuPage)).toBeVisible();
    const afterScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;
    expect(afterScrollTop).toBeLessThanOrEqual(beforeScrollTop + 8);
  });

  test("continuous output freezes review and returns to the latest live output", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-frozen-review`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 240, prefix: "frozen-history" });
    await expectPtyScrollable(emuPage, 200);

    // Touch gesture recognition is covered by the preceding Android cases. Keep
    // this continuous-output case focused on review-frame freezing by entering
    // the prerequisite state deterministically and verifying it explicitly.
    await scrollPtyToTop(emuPage);
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((debug) => debug?.verticalIntent.mode))
      .toBe("reviewing");
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);

    const snapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(snapshot).toBeVisible();
    const frozenText = await snapshot.textContent();
    const frozenBox = await snapshot.boundingBox();

    for (let index = 1; index <= 12; index += 1) {
      await sendPtyOutput(emuPage, `mobile-live-append ${String(index).padStart(2, "0")}\r\n`);
      await emuPage.waitForTimeout(50);
    }

    await expect(snapshot).toHaveText(frozenText ?? "");
    await expect(snapshot).not.toContainText("mobile-live-append");
    expect(await snapshot.boundingBox()).toEqual(frozenBox);
    const button = backToBottom(emuPage);
    await expect(button).toHaveAttribute("aria-label", "回到最新");

    await touchTap(emuPage, button);

    await expectPtyCursorAwareBottom(emuPage);
    await expect(snapshot).toHaveCount(0);
    await expect(button).toHaveJSProperty("inert", true);
    const liveRows = emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows');
    await expect(liveRows).toContainText("mobile-live-append 12");

    await sendPtyOutput(emuPage, "mobile-live-after-return\r\n");
    await expect(liveRows).toContainText("mobile-live-after-return");
    await expectPtyCursorAwareBottom(emuPage);
  });
});
