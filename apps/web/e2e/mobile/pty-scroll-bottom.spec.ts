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
  options: { primeMovePx?: number } = {},
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    let primedProgress = 0;
    if (options.primeMovePx) {
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      primedProgress = distance > 0 ? Math.min(1, options.primeMovePx / distance) : 0;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * primedProgress,
            y: start.y + (end.y - start.y) * primedProgress,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          },
        ],
      });
    }
    for (let step = 1; step <= 4; step += 1) {
      const progress = step / 4;
      if (progress <= primedProgress) continue;
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
  renderedBufferLine: number | null;
  renderedSource: "live-backfill" | "native" | null;
  viewportBridgeActive: boolean;
  renderedLineContentTop: number | null;
  renderedRowHeight: number | null;
  renderedFrameIdentityDriftRows: number | null;
  renderedTopOrSeamGap: number | null;
  renderedBottomGap: number | null;
}

interface VisibleNativeRow {
  text: string;
  top: number;
  bottom: number;
  height: number;
  fullyVisible: boolean;
}

async function visibleNativeRows(page: Page): Promise<VisibleNativeRow[]> {
  return ptyTerminal(page).evaluate((container) => {
    const containerRect = container.getBoundingClientRect();
    const containerStyle = getComputedStyle(container);
    const contentTop = containerRect.top + (Number.parseFloat(containerStyle.paddingTop) || 0);
    const contentBottom =
      containerRect.bottom - (Number.parseFloat(containerStyle.paddingBottom) || 0);
    const screen = container.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    if (!screen) return [];
    const nativeRows = Array.from(screen.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("xterm-rows") &&
        child.dataset.slot === undefined,
    );
    if (!nativeRows) return [];

    return Array.from(nativeRows.children)
      .filter((row): row is HTMLElement => row instanceof HTMLElement)
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          text: row.textContent ?? "",
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          fullyVisible: rect.top >= contentTop - 1 && rect.bottom <= contentBottom + 1,
        };
      })
      .filter((row) => row.bottom > contentTop && row.top < contentBottom);
  });
}

async function waitForAnimationFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
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
        const screen = document.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
        const nativeRows =
          screen &&
          Array.from(screen.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement &&
              child.classList.contains("xterm-rows") &&
              child.dataset.slot === undefined,
          );
        const backfill = screen?.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
        const backfillRows = backfill?.querySelector<HTMLElement>(".xterm-rows") ?? null;
        const backfillStartLine = Number(backfill?.dataset.startLine);
        const backfillEndLine = Number(backfill?.dataset.endLine);
        const viewportBridgeActive =
          Number.isInteger(backfillEndLine) && backfillEndLine >= snapshot.term.viewportY;
        // A short remote PTY paints one continuous viewport from two sources: serialized rows
        // above the host and xterm's native rows below it. Sample that visible composite instead
        // of assuming either source owns the whole phone viewport during a deferred touch frame.
        const rowSources: Array<{
          kind: "live-backfill" | "native";
          rows: HTMLElement;
          startLine: number | null;
          clipTop: number;
          clipBottom: number;
        }> = [];
        if (backfill && backfillRows) {
          const rect = backfill.getBoundingClientRect();
          rowSources.push({
            kind: "live-backfill",
            rows: backfillRows,
            startLine: Number.isInteger(backfillStartLine) ? backfillStartLine : null,
            clipTop: rect.top,
            clipBottom: rect.bottom,
          });
        }
        // A viewport bridge is opaque and intentionally covers the old native rows until xterm's
        // next render. Do not count the hidden rows underneath as a second visible source.
        if (!viewportBridgeActive && screen && nativeRows) {
          const rect = screen.getBoundingClientRect();
          rowSources.push({
            kind: "native",
            rows: nativeRows,
            startLine: snapshot.term.viewportY,
            clipTop: rect.top,
            clipBottom: rect.bottom,
          });
        }
        let renderedLine: number | null = null;
        let renderedBufferLine: number | null = null;
        let renderedSource: "live-backfill" | "native" | null = null;
        let renderedLineContentTop: number | null = null;
        let renderedRowHeight: number | null = null;
        let renderedFrameIdentityDriftRows: number | null = null;
        let renderedTopOrSeamGap: number | null = null;
        let renderedBottomGap: number | null = null;
        if (rowSources.length > 0) {
          const containerRect = scrollContainer.getBoundingClientRect();
          const containerStyle = getComputedStyle(scrollContainer);
          const contentTop =
            containerRect.top + (Number.parseFloat(containerStyle.paddingTop) || 0);
          const contentBottom =
            containerRect.bottom - (Number.parseFloat(containerStyle.paddingBottom) || 0);
          const paintedIntervals: Array<{ top: number; bottom: number }> = [];
          const identifiedRows: Array<{
            line: number;
            bufferLine: number | null;
            source: "live-backfill" | "native";
            top: number;
            height: number;
          }> = [];

          for (const source of rowSources) {
            for (const [rowIndex, child] of Array.from(source.rows.children).entries()) {
              if (!(child instanceof HTMLElement)) continue;
              const rect = child.getBoundingClientRect();
              const paintedTop = Math.max(contentTop, source.clipTop, rect.top);
              const paintedBottom = Math.min(contentBottom, source.clipBottom, rect.bottom);
              if (paintedBottom <= paintedTop) continue;
              paintedIntervals.push({ top: paintedTop, bottom: paintedBottom });

              const match = child.textContent?.match(/(?:rapid-review|visible-live-tail)\s+(\d+)/);
              if (!match) continue;
              identifiedRows.push({
                line: Number.parseInt(match[1], 10),
                bufferLine: source.startLine === null ? null : source.startLine + rowIndex,
                source: source.kind,
                top: rect.top,
                height: rect.height,
              });
            }
          }

          paintedIntervals.sort((left, right) => left.top - right.top);
          let paintedThrough = contentTop;
          renderedTopOrSeamGap = 0;
          for (const interval of paintedIntervals) {
            renderedTopOrSeamGap = Math.max(
              renderedTopOrSeamGap,
              Math.max(0, interval.top - paintedThrough),
            );
            paintedThrough = Math.max(paintedThrough, interval.bottom);
          }
          renderedBottomGap = Math.max(0, contentBottom - paintedThrough);

          identifiedRows.sort((left, right) => left.top - right.top || left.line - right.line);
          const firstVisible = identifiedRows[0] ?? null;
          if (firstVisible) {
            renderedLine = firstVisible.line;
            renderedBufferLine = firstVisible.bufferLine;
            renderedSource = firstVisible.source;
            renderedLineContentTop = firstVisible.top - contentTop + snapshot.container.scrollTop;
            renderedRowHeight = firstVisible.height;
            renderedFrameIdentityDriftRows = Math.max(
              ...identifiedRows.map((row) => {
                const physicalRowDelta =
                  (row.top - firstVisible.top) / Math.max(firstVisible.height, 1);
                const contentIdentityDelta = row.line - firstVisible.line;
                const bufferIdentityDelta =
                  row.bufferLine === null || firstVisible.bufferLine === null
                    ? contentIdentityDelta
                    : row.bufferLine - firstVisible.bufferLine;
                return Math.max(
                  Math.abs(physicalRowDelta - contentIdentityDelta),
                  Math.abs(bufferIdentityDelta - contentIdentityDelta),
                );
              }),
            );
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
          renderedBufferLine,
          renderedSource,
          viewportBridgeActive,
          renderedLineContentTop,
          renderedRowHeight,
          renderedFrameIdentityDriftRows,
          renderedTopOrSeamGap,
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
  const renderedSamples = samples.filter(
    (
      sample,
    ): sample is ReviewScrollSample & {
      renderedLine: number;
      renderedBufferLine: number;
      renderedLineContentTop: number;
      renderedRowHeight: number;
      renderedFrameIdentityDriftRows: number;
    } =>
      sample.renderedLine !== null &&
      sample.renderedBufferLine !== null &&
      sample.renderedLineContentTop !== null &&
      sample.renderedRowHeight !== null &&
      sample.renderedFrameIdentityDriftRows !== null,
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
  const settledHostSamples = samples.filter((sample) => !sample.viewportBridgeActive);
  const maxSettledHostTopDrift = Math.max(
    0,
    ...settledHostSamples.map((sample) => Math.abs(sample.hostTopDrift)),
  );
  const maxRenderedBufferIdentityDriftRows = Math.max(
    ...renderedSamples.map((sample) =>
      Math.abs(
        sample.renderedBufferLine -
          baseline.renderedBufferLine -
          (sample.renderedLine - baseline.renderedLine),
      ),
    ),
  );
  const maxRenderedFrameIdentityDriftRows = Math.max(
    ...renderedSamples.map((sample) => sample.renderedFrameIdentityDriftRows),
  );
  const maxRenderedTopOrSeamGap = Math.max(
    ...samples.map((sample) => sample.renderedTopOrSeamGap ?? Number.POSITIVE_INFINITY),
  );
  const maxRenderedBottomGap = Math.max(...samples.map((sample) => sample.renderedBottomGap ?? 0));

  expect(samples.length).toBeGreaterThan(10);
  expect(scrollRange).toBeGreaterThan(options.minimumScrollRange);
  // While the compositor is ahead of xterm, the opaque live bridge is the visual authority and
  // the host deliberately stays at its last painted row. Once the bridge settles, host geometry
  // must again agree with the logical viewport within one row.
  expect(maxSettledHostTopDrift).toBeLessThanOrEqual(maxRenderedRowHeight + 1);
  // The xterm buffer may swap which row occupies a viewport slot as the user scrolls. Its buffer
  // line number and physical content position must nevertheless advance together without gaps.
  expect(maxRenderedGeometryDriftRows).toBeLessThanOrEqual(0.05);
  expect(maxRenderedBufferIdentityDriftRows).toBeLessThanOrEqual(0);
  expect(maxRenderedFrameIdentityDriftRows).toBeLessThanOrEqual(0.05);
  expect(maxRenderedTopOrSeamGap).toBeLessThanOrEqual(1);
  expect(maxRenderedBottomGap).toBeLessThanOrEqual(8);
}

function expectViewportNeverPulledTowardBottom(samples: ReviewScrollSample[]): void {
  expect(samples.length).toBeGreaterThan(10);
  expect(Math.min(...samples.map((sample) => sample.viewportY))).toBeLessThan(samples[0].viewportY);

  // A one-paint viewport bridge deliberately advances xterm's logical viewport before moving its
  // old DOM rows. During that frame the native scroll position is the visual authority; only
  // settled reviewing samples may be compared as xterm viewport positions.
  const domMoves = samples
    .slice(1)
    .map((sample, index) => sample.scrollTop - samples[index].scrollTop);
  expect(Math.max(...domMoves)).toBeLessThanOrEqual(0);

  const settledReviewSamples = samples.filter(
    (sample) => sample.intentMode === "reviewing" && !sample.viewportBridgeActive,
  );
  expect(settledReviewSamples.length).toBeGreaterThan(1);
  const settledViewportMoves = settledReviewSamples
    .slice(1)
    .map((sample, index) => sample.viewportY - settledReviewSamples[index].viewportY);
  expect(Math.max(...settledViewportMoves)).toBeLessThanOrEqual(0);
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

  test("passive live output never leaves the terminal screen above the viewport bottom", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-passive-live-gap`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 270, rows: 57 });
    await sendPtyLines(emuPage, { count: 520, prefix: "passive-live-history" });
    await expectPtyCursorAwareBottom(emuPage);

    await startReviewScrollSampling(emuPage);
    for (let index = 1; index <= 120; index += 1) {
      await sendPtyOutput(emuPage, `passive-live-output ${String(index).padStart(3, "0")}\r\n`);
      await emuPage.waitForTimeout(8);
    }
    await emuPage.waitForTimeout(300);
    const samples = await stopReviewScrollSampling(emuPage);
    const bottomGapViolations = samples.filter((sample) => (sample.renderedBottomGap ?? 0) > 8);
    const reviewViolations = samples.filter((sample) => sample.intentMode !== "following");

    expect(samples.length).toBeGreaterThan(40);
    expect(bottomGapViolations, JSON.stringify(bottomGapViolations, null, 2)).toEqual([]);
    expect(reviewViolations, JSON.stringify(reviewViolations, null, 2)).toEqual([]);
    await expectPtyCursorAwareBottom(emuPage);
    await expect(
      emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows'),
    ).toContainText("passive-live-output 120");
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
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);

    const button = backToBottom(emuPage);
    await expect(button).toBeVisible();
    await expect(button).toHaveJSProperty("inert", false);

    await touchTap(emuPage, button);
    await expectPtyCursorAwareBottom(emuPage);
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
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
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("bottom-drift 259");
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

  test("shallow history touch keeps a visible live status updating without a snapshot", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-visible-live-tail`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 120, rows: 54 });
    await sendPtyLines(emuPage, { count: 260, prefix: "visible-live-tail" });
    await sendPtyOutput(emuPage, "WORKING elapsed 01s\r\nSTATUS FOOTER A\r\nSTATUS FOOTER B");
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("WORKING elapsed 01s");
    await expectPtyCursorAwareBottom(emuPage);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const rowHeight = await emuPage
      .locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows > div')
      .first()
      .evaluate((row) => row.getBoundingClientRect().height);
    const x = box.x + box.width / 2;
    const startY = box.y + box.height * 0.42;
    const shallowDistance = Math.max(20, Math.min(rowHeight * 1.25, 30));
    // Prime the pan before CDP round-trip latency can turn this shallow scroll into a long press.
    await touchDrag(
      emuPage,
      { x, y: startY },
      { x, y: startY + shallowDistance },
      { primeMovePx: 10 },
    );
    await waitForAnimationFrames(emuPage);

    await expect
      .poll(async () => {
        const snapshot = await readPtyDebugSnapshot(emuPage);
        return {
          mode: snapshot?.verticalIntent.mode,
          awayFromBottom: (snapshot?.anchor.scrollTopDeltaToBottom ?? 0) < -8,
        };
      })
      .toEqual({ mode: "reviewing", awayFromBottom: true });

    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(reviewSnapshot).toHaveCount(0);
    const beforeUpdate = await readPtyDebugSnapshot(emuPage);
    if (!beforeUpdate) throw new Error("PTY debug snapshot is not available");
    const workingBefore = (await visibleNativeRows(emuPage)).find((row) =>
      row.text.includes("WORKING elapsed 01s"),
    );
    expect(workingBefore, "the in-place Working row must remain visible").toBeTruthy();

    await sendPtyOutput(emuPage, "\u001b7\u001b[2A\rWORKING elapsed 02s\u001b[K\u001b8");
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("WORKING elapsed 02s");
    await expect
      .poll(() => visibleNativeRows(emuPage).then((rows) => rows.map((row) => row.text).join("\n")))
      .toContain("WORKING elapsed 02s");

    const afterUpdate = await readPtyDebugSnapshot(emuPage);
    if (!afterUpdate) throw new Error("PTY debug snapshot is not available");
    expect(afterUpdate.container.scrollTop).toBeCloseTo(beforeUpdate.container.scrollTop, 0);
    expect(afterUpdate.verticalIntent.mode).toBe("reviewing");
    const workingAfter = (await visibleNativeRows(emuPage)).find((row) =>
      row.text.includes("WORKING elapsed 02s"),
    );
    expect(workingAfter, "the updated Working row must remain visible in place").toBeTruthy();
    expect(workingAfter?.top).toBeCloseTo(workingBefore?.top ?? Number.NaN, 0);
    await expect(reviewSnapshot).toHaveCount(0);
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
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
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
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
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
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
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
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
    const beforeScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;

    await sendPtyOutput(emuPage, "frame-while-user-scrolled-up\r\n");

    await expect(backToBottomNewIndicator(emuPage)).toBeVisible();
    const afterScrollTop = (await readPtyScrollMetrics(emuPage)).scrollTop;
    expect(afterScrollTop).toBeLessThanOrEqual(beforeScrollTop + 8);
    await expect(emuPage.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);
  });

  test("continuous output keeps the read position anchored; BackToBottom jumps explicitly", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-history-anchor`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 240, prefix: "anchored-history" });
    await expectPtyScrollable(emuPage, 200);
    await expectPtyCursorAwareBottom(emuPage);

    const terminalBox = await ptyTerminal(emuPage).boundingBox();
    if (!terminalBox) throw new Error("PTY terminal is not visible");
    const x = terminalBox.x + terminalBox.width / 2;
    await touchDrag(
      emuPage,
      { x, y: terminalBox.y + terminalBox.height * 0.28 },
      { x, y: terminalBox.y + terminalBox.height * 0.72 },
    );
    await waitForAnimationFrames(emuPage);
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((debug) => debug?.verticalIntent.mode))
      .toBe("reviewing");
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(100);

    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(reviewSnapshot).toHaveCount(0);
    const anchor = (await visibleNativeRows(emuPage)).find(
      (row) => row.fullyVisible && row.text.includes("anchored-history"),
    );
    expect(anchor, "a fully visible history row is required as the mobile anchor").toBeTruthy();
    const beforeOutput = await readPtyScrollMetrics(emuPage);

    for (let index = 1; index <= 24; index += 1) {
      await sendPtyOutput(emuPage, `mobile-live-append ${String(index).padStart(2, "0")}\r\n`);
      await emuPage.waitForTimeout(25);
    }
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("mobile-live-append 24");
    await waitForAnimationFrames(emuPage);

    const afterOutput = await readPtyScrollMetrics(emuPage);
    expect(afterOutput.scrollTop).toBeCloseTo(beforeOutput.scrollTop, 0);
    expect(afterOutput.maxScrollTop).toBeGreaterThan(beforeOutput.maxScrollTop);
    const anchoredAfterOutput = (await visibleNativeRows(emuPage)).find(
      (row) => row.text === anchor?.text,
    );
    expect(anchoredAfterOutput, "background output must preserve the row being read").toBeTruthy();
    expect(anchoredAfterOutput?.top).toBeCloseTo(anchor?.top ?? Number.NaN, 0);
    await expect(reviewSnapshot).toHaveCount(0);
    await expect(backToBottomNewIndicator(emuPage)).toBeVisible();
    const button = backToBottom(emuPage);
    await expect(button).toHaveAttribute("aria-label", "回到最新");

    await touchTap(emuPage, button);

    await expectPtyCursorAwareBottom(emuPage);
    await expect(reviewSnapshot).toHaveCount(0);
    await expect(button).toHaveJSProperty("inert", true);
    const liveRows = emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows');
    await expect(liveRows).toContainText("mobile-live-append 24");

    await sendPtyOutput(emuPage, "mobile-live-after-return\r\n");
    await expect(liveRows).toContainText("mobile-live-after-return");
    await expectPtyCursorAwareBottom(emuPage);
  });

  test("toward-live touch walks through appended rows before reaching the latest output", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-touch-progressive-tail`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await enterLongHostMode(emuPage, { sessionId, cols: 270, rows: 57 });
    await sendPtyLines(emuPage, { count: 520, prefix: "touch-history" });
    await expectPtyCursorAwareBottom(emuPage);
    const oldLiveBottom = (await readPtyScrollMetrics(emuPage)).scrollTop;

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    await touchDrag(
      emuPage,
      { x, y: box.y + box.height * 0.22 },
      { x, y: box.y + box.height * 0.78 },
    );
    await waitForAnimationFrames(emuPage);
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((debug) => debug?.verticalIntent.mode))
      .toBe("reviewing");
    await expect
      .poll(() => readPtyScrollMetrics(emuPage).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(200);
    const reviewSnapshot = emuPage.locator('[data-slot="pty-review-snapshot"]');
    await expect(reviewSnapshot).toHaveCount(0);
    const historyAnchor = (await visibleNativeRows(emuPage)).find(
      (row) => row.fullyVisible && row.text.includes("touch-history"),
    );
    expect(historyAnchor, "a visible mobile history row is required before output").toBeTruthy();
    const beforeOutput = await readPtyScrollMetrics(emuPage);

    for (let index = 1; index <= 48; index += 1) {
      await sendPtyOutput(emuPage, `touch-live ${String(index).padStart(2, "0")}\r\n`);
    }
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("touch-live 48");
    await waitForAnimationFrames(emuPage);
    const afterOutput = await readPtyScrollMetrics(emuPage);
    expect(afterOutput.scrollTop).toBeCloseTo(beforeOutput.scrollTop, 0);
    expect(afterOutput.maxScrollTop).toBeGreaterThan(beforeOutput.maxScrollTop);
    const historyAnchorAfterOutput = (await visibleNativeRows(emuPage)).find(
      (row) => row.text === historyAnchor?.text,
    );
    expect(
      historyAnchorAfterOutput,
      "new output must not replace the history viewport",
    ).toBeTruthy();
    expect(historyAnchorAfterOutput?.top).toBeCloseTo(historyAnchor?.top ?? Number.NaN, 0);
    await expect(reviewSnapshot).toHaveCount(0);

    const cellHeight = historyAnchor?.height ?? 0;
    const gestureDistance = Math.max(72, Math.min(box.height * 0.18, 112));
    const traversedFrames: string[] = [];
    let crossedOldBottomWhileStillReviewing = false;
    for (let step = 0; step < 24; step += 1) {
      const beforeStep = await readPtyScrollMetrics(emuPage);
      if (beforeStep.bottomGap <= 8) break;

      const startY = box.y + box.height * 0.7;
      await touchDrag(emuPage, { x, y: startY }, { x, y: startY - gestureDistance });
      await waitForAnimationFrames(emuPage);
      const afterStep = await readPtyScrollMetrics(emuPage);
      const travel = afterStep.scrollTop - beforeStep.scrollTop;
      expect(travel, `touch step ${step + 1} must move toward live output`).toBeGreaterThanOrEqual(
        -2,
      );
      expect(
        travel,
        `touch step ${step + 1} must not jump across the newly appended range`,
      ).toBeLessThanOrEqual(gestureDistance + cellHeight + 16);
      traversedFrames.push((await visibleNativeRows(emuPage)).map((row) => row.text).join("\n"));
      if (beforeStep.scrollTop < oldLiveBottom - 8 && afterStep.scrollTop >= oldLiveBottom - 8) {
        expect(afterStep.bottomGap).toBeGreaterThan(8);
        crossedOldBottomWhileStillReviewing = true;
      }
    }

    expect(crossedOldBottomWhileStillReviewing).toBe(true);
    expect(
      traversedFrames.some(
        (text) => /touch-live (?:0[1-9]|1\d)/.test(text) && !text.includes("touch-live 48"),
      ),
      "ordinary touch scrolling must expose intermediate appended rows before the latest row",
    ).toBe(true);
    await expectPtyCursorAwareBottom(emuPage);
    await expect(reviewSnapshot).toHaveCount(0);
    await expect(
      emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows'),
    ).toContainText("touch-live 48");
    await expect.poll(() => readPtyScreenBottomGap(emuPage)).toBeLessThanOrEqual(8);

    await sendPtyOutput(emuPage, "touch-after-return\r\n");
    await expect(
      emuPage.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows'),
    ).toContainText("touch-after-return");
    await expect
      .poll(() => readPtyDebugSnapshot(emuPage).then((debug) => debug?.verticalIntent.mode))
      .toBe("following");
    await expect(reviewSnapshot).toHaveCount(0);
    await expectPtyCursorAwareBottom(emuPage);
    await expect.poll(() => readPtyScreenBottomGap(emuPage)).toBeLessThanOrEqual(8);
  });
});
