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
  expectPtyAtBottom,
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
  hostTopDrift: number;
  renderedLine: number | null;
  renderedLineContentTop: number | null;
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
            const match = row.textContent?.match(/rapid-review\s+(\d+)/);
            if (!match) continue;
            renderedLine = Number.parseInt(match[1], 10);
            const rowRect = row.getBoundingClientRect();
            renderedLineContentTop = rowRect.top - containerRect.top + snapshot.container.scrollTop;
            renderedRowHeight = rowRect.height;
            break;
          }
        }
        testWindow.__ptyReviewScrollSamples?.push({
          scrollTop: snapshot.container.scrollTop,
          hostTopDrift: snapshot.host.topDrift,
          renderedLine,
          renderedLineContentTop,
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
  const baselineRenderedOffset =
    baseline.renderedLineContentTop - baseline.renderedLine * baseline.renderedRowHeight;
  const maxRenderedGeometryDrift = Math.max(
    ...renderedSamples.map((sample) =>
      Math.abs(
        sample.renderedLineContentTop -
          sample.renderedLine * baseline.renderedRowHeight -
          baselineRenderedOffset,
      ),
    ),
  );
  const scrollRange =
    Math.max(...samples.map((sample) => sample.scrollTop)) -
    Math.min(...samples.map((sample) => sample.scrollTop));
  const maxRenderedBottomGap = Math.max(...samples.map((sample) => sample.renderedBottomGap ?? 0));

  expect(samples.length).toBeGreaterThan(10);
  expect(scrollRange).toBeGreaterThan(options.minimumScrollRange);
  expect(maxHostTopDrift).toBeLessThanOrEqual(20);
  expect(maxRenderedGeometryDrift).toBeLessThanOrEqual(20);
  expect(maxRenderedBottomGap).toBeLessThanOrEqual(8);
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

test.describe("L4 mobile / PTY scroll back-to-bottom", () => {
  test.setTimeout(60_000);

  test("PTY screen covers the mobile scroll viewport without a full-row bottom blank", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 120 });
    await expectPtyAtBottom(emuPage);

    await expect.poll(() => readPtyScreenBottomGap(emuPage)).toBeLessThanOrEqual(8);
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
    await expectPtyAtBottom(emuPage);
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
      .poll(() => emuPage.locator('[data-slot="pty-host"] .xterm-rows').last().textContent())
      .toContain("WORKING elapsed 02s");
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

  test("continuous output does not repaint the reviewed frame", async ({ emuPage }) => {
    const sessionId = `${SESSION_ID}-frozen-review`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await sendPtyLines(emuPage, { count: 240, prefix: "frozen-history" });
    await expectPtyScrollable(emuPage, 200);

    const box = await ptyTerminal(emuPage).boundingBox();
    if (!box) throw new Error("PTY terminal is not visible");
    const x = box.x + box.width / 2;
    await touchDrag(
      emuPage,
      { x, y: box.y + box.height * 0.35 },
      { x, y: box.y + box.height * 0.75 },
    );

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
    await expect(backToBottom(emuPage)).toHaveAttribute("aria-label", "回到最新");
  });
});
