import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import { sendPtyOutput } from "../pty-scroll-helpers";

const VIEWPORT = { width: 390, height: 844 };
const COLS = 180;
const ROWS = 28;
const HISTORY_LINES = 240;

test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
test.describe.configure({ retries: 0 });
test.setTimeout(90_000);

interface Point {
  x: number;
  y: number;
}

interface ManagedRange {
  anchor: { row: number; column: number };
  focus: { row: number; column: number };
}

interface SelectionSnapshot extends ManagedRange {
  handles: number;
  toolbarVisible: boolean;
  segments: number;
}

type HandleGeometryPhase = "idle" | "active" | "inertia";

interface HandleGeometrySample {
  phase: HandleGeometryPhase;
  time: number;
  scrollTop: number;
  toolbarVisible: boolean;
  anchorError: number;
  focusError: number;
  maxError: number;
}

type HandleGeometryProbeWindow = Window & {
  __ptyHandleGeometryPhase?: HandleGeometryPhase;
  __ptyHandleGeometrySamples?: HandleGeometrySample[];
  __stopPtyHandleGeometryProbe?: () => void;
};

let nextTouchId = 1;

async function dispatchTouch(
  client: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  point?: Point,
  touchId?: number,
): Promise<void> {
  const parameters = {
    type,
    touchPoints:
      type === "touchEnd" || type === "touchCancel" || !point
        ? []
        : [
            {
              x: point.x,
              y: point.y,
              id: touchId,
              radiusX: 3,
              radiusY: 3,
              force: 1,
            },
          ],
  };
  try {
    await client.send("Input.dispatchTouchEvent", parameters);
  } catch (error) {
    throw new Error(
      `Input.dispatchTouchEvent rejected ${JSON.stringify(parameters)}: ${String(error)}`,
      { cause: error },
    );
  }
}

async function touchTap(client: CDPSession, point: Point): Promise<void> {
  const touchId = nextTouchId++;
  await dispatchTouch(client, "touchStart", point, touchId);
  await new Promise((resolve) => setTimeout(resolve, 70));
  await dispatchTouch(client, "touchEnd");
}

async function longPress(client: CDPSession, point: Point): Promise<void> {
  const touchId = nextTouchId++;
  await dispatchTouch(client, "touchStart", point, touchId);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await dispatchTouch(client, "touchEnd");
}

async function touchPan(
  client: CDPSession,
  start: Point,
  end: Point,
  options: {
    steps?: number;
    stepDelayMs?: number;
    settleMs?: number;
    onTouchEnd?: () => Promise<void>;
  } = {},
): Promise<void> {
  const steps = options.steps ?? 14;
  const touchId = nextTouchId++;
  await dispatchTouch(client, "touchStart", start, touchId);
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await dispatchTouch(
      client,
      "touchMove",
      {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      },
      touchId,
    );
    await new Promise((resolve) => setTimeout(resolve, options.stepDelayMs ?? 18));
  }
  await dispatchTouch(client, "touchEnd");
  await options.onTouchEnd?.();
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 350));
}

async function installHandleGeometryProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probeWindow = window as HandleGeometryProbeWindow;
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    if (!container) throw new Error("PTY terminal missing while installing handle geometry probe");

    probeWindow.__ptyHandleGeometrySamples = [];
    probeWindow.__ptyHandleGeometryPhase = "idle";
    let raf = 0;

    const sample = (): void => {
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="pty-managed-selection-overlay"]',
      );
      const anchorHandle = document.querySelector<HTMLElement>(
        '[data-slot="pty-selection-handle"][data-kind="anchor"]',
      );
      const focusHandle = document.querySelector<HTMLElement>(
        '[data-slot="pty-selection-handle"][data-kind="focus"]',
      );
      if (!overlay || !anchorHandle || !focusHandle) return;

      const anchorRow = Number(overlay.dataset.anchorRow);
      const anchorColumn = Number(overlay.dataset.anchorColumn);
      const focusRow = Number(overlay.dataset.focusRow);
      const focusColumn = Number(overlay.dataset.focusColumn);
      if (![anchorRow, anchorColumn, focusRow, focusColumn].every(Number.isFinite)) return;
      // This gate deliberately selects one ASCII token, so one overlay segment owns both exact
      // endpoints. Multi-line/wide-character semantics are covered by their dedicated gates.
      if (anchorRow !== focusRow) return;

      const segment = Array.from(
        overlay.querySelectorAll<HTMLElement>('[data-slot="pty-managed-selection-segment"]'),
      ).find((candidate) => {
        const firstRow = Number(candidate.dataset.firstRow);
        const lastRow = Number(candidate.dataset.lastRow);
        return firstRow <= anchorRow && lastRow >= anchorRow;
      });
      if (!segment) return;

      const segmentRect = segment.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      // Sample only fully visible endpoints so outer overflow clipping cannot turn a valid
      // offscreen handle into an ambiguous geometry comparison.
      if (
        segmentRect.top < containerRect.top + 30 ||
        segmentRect.bottom > containerRect.bottom - 30
      ) {
        return;
      }

      const anchorRect = anchorHandle.getBoundingClientRect();
      const focusRect = focusHandle.getBoundingClientRect();
      const anchorCenter = {
        x: anchorRect.left + anchorRect.width / 2,
        y: anchorRect.top + anchorRect.height / 2,
      };
      const focusCenter = {
        x: focusRect.left + focusRect.width / 2,
        y: focusRect.top + focusRect.height / 2,
      };
      const anchorComesFirst = anchorColumn <= focusColumn;
      const anchorEndpointX = anchorComesFirst ? segmentRect.left : segmentRect.right;
      const focusEndpointX = anchorComesFirst ? segmentRect.right : segmentRect.left;
      const anchorError = Math.hypot(
        anchorCenter.x - anchorEndpointX,
        anchorCenter.y - segmentRect.bottom,
      );
      const focusError = Math.hypot(
        focusCenter.x - focusEndpointX,
        focusCenter.y - segmentRect.bottom,
      );
      probeWindow.__ptyHandleGeometrySamples?.push({
        phase: probeWindow.__ptyHandleGeometryPhase ?? "idle",
        time: performance.now(),
        scrollTop: container.scrollTop,
        toolbarVisible: document.querySelector('[data-slot="pty-selection-toolbar"]') !== null,
        anchorError,
        focusError,
        maxError: Math.max(anchorError, focusError),
      });
    };

    const onFrame = (): void => {
      sample();
      raf = requestAnimationFrame(onFrame);
    };
    raf = requestAnimationFrame(onFrame);
    probeWindow.__stopPtyHandleGeometryProbe = () => cancelAnimationFrame(raf);
  });
}

async function setHandleGeometryPhase(page: Page, phase: HandleGeometryPhase): Promise<void> {
  await page.evaluate((nextPhase) => {
    (window as HandleGeometryProbeWindow).__ptyHandleGeometryPhase = nextPhase;
  }, phase);
}

async function stopHandleGeometryProbe(page: Page): Promise<HandleGeometrySample[]> {
  return page.evaluate(() => {
    const probeWindow = window as HandleGeometryProbeWindow;
    probeWindow.__stopPtyHandleGeometryProbe?.();
    const samples = probeWindow.__ptyHandleGeometrySamples ?? [];
    delete probeWindow.__stopPtyHandleGeometryProbe;
    delete probeWindow.__ptyHandleGeometrySamples;
    delete probeWindow.__ptyHandleGeometryPhase;
    return samples;
  });
}

function expectHandleGeometryAttached(
  samples: HandleGeometrySample[],
  phase: Exclude<HandleGeometryPhase, "idle">,
): void {
  const phaseSamples = samples.filter((sample) => sample.phase === phase);
  const distinctScrollTops = new Set(phaseSamples.map((sample) => sample.scrollTop.toFixed(2)));
  expect(phaseSamples.length, `${phase} geometry samples`).toBeGreaterThanOrEqual(10);
  // CDP touchEnd does not deterministically produce kinetic scrolling in every headless run.
  // The active phase must prove real motion; the post-release phase still guards against a late
  // React correction after the finger leaves, whether or not that run receives compositor coast.
  if (phase === "active") {
    expect(distinctScrollTops.size, `${phase} distinct scrollTop samples`).toBeGreaterThanOrEqual(
      5,
    );
  }

  const worst = [...phaseSamples].sort((left, right) => right.maxError - left.maxError).slice(0, 5);
  const maxError = worst[0]?.maxError ?? Number.POSITIVE_INFINITY;
  expect(
    maxError,
    `${phase} handle-to-selection endpoint error exceeded 2px: ${JSON.stringify(worst)}`,
  ).toBeLessThanOrEqual(2);
}

function expectToolbarHiddenDuringActiveScroll(
  samples: HandleGeometrySample[],
  initialScrollTop: number,
): void {
  const movingSamples = samples.filter(
    (sample) => sample.phase === "active" && Math.abs(sample.scrollTop - initialScrollTop) > 1,
  );
  expect(movingSamples.length, "active moving toolbar samples").toBeGreaterThanOrEqual(5);
  // React may commit the first native scroll event at the end of that browser task. From the next
  // painted frame onward the fixed viewport toolbar must be gone until scrolling settles.
  expect(
    movingSamples.slice(1).filter((sample) => sample.toolbarVisible),
    `toolbar remained visible while the selected content moved: ${JSON.stringify(movingSamples)}`,
  ).toHaveLength(0);
}

async function prepareTerminal(page: Page, sessionId: string): Promise<void> {
  await setupPtyChat(page, { sessionId, cols: COLS, rows: ROWS });
  await expectPtyTerminalMounted(page, { timeout: 15_000 });
  await page.evaluate(({ cols, rows }) => window.__ptySmoke.resize(cols, rows), {
    cols: COLS,
    rows: ROWS,
  });
  await expect
    .poll(
      () =>
        page.evaluate((sid) => {
          const terminal = window.__ccTestPtyTerminals?.get(sid);
          return terminal ? { cols: terminal.cols, rows: terminal.rows } : null;
        }, sessionId),
      { timeout: 10_000 },
    )
    .toEqual({ cols: COLS, rows: ROWS });

  await sendPtyOutput(
    page,
    Array.from(
      { length: HISTORY_LINES },
      (_, index) =>
        `HISTORY_${String(index).padStart(3, "0")} KEEP_SELECTION_TOKEN_${String(index).padStart(3, "0")} ${"x".repeat(88)}\r\n`,
    ).join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId), {
      timeout: 10_000,
    })
    .toContain("KEEP_SELECTION_TOKEN_239");
  await expect
    .poll(() => readScrollPosition(page))
    .toMatchObject({ verticalScrollable: true, horizontalScrollable: true });
}

async function readScrollPosition(page: Page): Promise<{
  scrollLeft: number;
  scrollTop: number;
  maxScrollLeft: number;
  maxScrollTop: number;
  horizontalScrollable: boolean;
  verticalScrollable: boolean;
}> {
  return page.locator('[data-slot="pty-terminal"]').evaluate((element) => {
    const container = element as HTMLElement;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    return {
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      maxScrollLeft,
      maxScrollTop,
      horizontalScrollable: maxScrollLeft > 40,
      verticalScrollable: maxScrollTop > 200,
    };
  });
}

async function locateVisibleToken(
  page: Page,
  sessionId: string,
): Promise<{ point: Point; text: string; range: ManagedRange }> {
  const target = await page.evaluate((sid) => {
    const terminal = window.__ccTestPtyTerminals?.get(sid);
    const screen = terminal?.element?.querySelector<HTMLElement>(".xterm-screen");
    const container = screen?.closest<HTMLElement>('[data-slot="pty-terminal"]');
    if (!terminal || !screen || !container || terminal.cols <= 0 || terminal.rows <= 0) return null;

    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    const buffer = terminal.buffer.active;
    for (let row = buffer.viewportY + 2; row < buffer.viewportY + terminal.rows - 3; row += 1) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      const match = /KEEP_SELECTION_TOKEN_\d{3}/u.exec(line);
      if (!match || match.index === undefined) continue;
      // A preceding handle drag may have legitimately autoscrolled the wide terminal, leaving
      // only the latter part of this token visible. Pick a real visible cell inside the token
      // instead of assuming its fixed sixth cell is still inside the scrollport.
      const firstVisibleColumn = Math.ceil(
        (containerRect.left + 20 - screenRect.left) / cellWidth - 0.5,
      );
      const lastVisibleColumn = Math.floor(
        (containerRect.right - 20 - screenRect.left) / cellWidth - 0.5,
      );
      const firstTargetColumn = Math.max(match.index, firstVisibleColumn);
      const lastTargetColumn = Math.min(match.index + match[0].length - 1, lastVisibleColumn);
      if (firstTargetColumn > lastTargetColumn) continue;
      const targetColumn = Math.floor((firstTargetColumn + lastTargetColumn) / 2);
      const x = screenRect.left + (targetColumn + 0.5) * cellWidth;
      const y = screenRect.top + (row - buffer.viewportY + 0.5) * cellHeight;
      if (
        x < containerRect.left + 20 ||
        x > containerRect.right - 20 ||
        y < containerRect.top + 50 ||
        y > containerRect.bottom - 90
      ) {
        continue;
      }
      return {
        point: { x, y },
        text: match[0],
        range: {
          anchor: { row, column: match.index },
          focus: { row, column: match.index + match[0].length - 1 },
        },
      };
    }
    return null;
  }, sessionId);
  if (!target) throw new Error("no visible selection token found in the native xterm screen");
  return target;
}

async function readSelectionSnapshot(page: Page): Promise<SelectionSnapshot | null> {
  return page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>(
      '[data-slot="pty-managed-selection-overlay"]',
    );
    if (!overlay) return null;
    const anchorRow = Number(overlay.dataset.anchorRow);
    const anchorColumn = Number(overlay.dataset.anchorColumn);
    const focusRow = Number(overlay.dataset.focusRow);
    const focusColumn = Number(overlay.dataset.focusColumn);
    if (![anchorRow, anchorColumn, focusRow, focusColumn].every(Number.isFinite)) return null;
    return {
      anchor: { row: anchorRow, column: anchorColumn },
      focus: { row: focusRow, column: focusColumn },
      handles: document.querySelectorAll('[data-slot="pty-selection-handle"]').length,
      toolbarVisible: document.querySelector('[data-slot="pty-selection-toolbar"]') !== null,
      segments: overlay.querySelectorAll('[data-slot="pty-managed-selection-segment"]').length,
    };
  });
}

async function readToolbarAttachment(page: Page): Promise<{
  visibleHandles: number;
  verticalGap: number;
} | null> {
  return page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-slot="pty-selection-toolbar"]');
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    if (!toolbar || !container) return null;
    const containerRect = container.getBoundingClientRect();
    const handleCenters = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="pty-selection-handle"]'),
    )
      .filter((handle) => {
        const style = getComputedStyle(handle);
        if (style.visibility === "hidden" || style.pointerEvents === "none") return false;
        const rect = handle.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return (
          centerX >= containerRect.left &&
          centerX <= containerRect.right &&
          centerY >= containerRect.top &&
          centerY <= containerRect.bottom
        );
      })
      .map((handle) => {
        const rect = handle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    if (handleCenters.length === 0) return { visibleHandles: 0, verticalGap: Infinity };
    const toolbarRect = toolbar.getBoundingClientRect();
    const nearestSelectionTop = Math.min(...handleCenters.map((center) => center.y));
    return {
      visibleHandles: handleCenters.length,
      verticalGap: Math.abs(nearestSelectionTop - toolbarRect.bottom),
    };
  });
}

async function establishSelection(
  page: Page,
  client: CDPSession,
  sessionId: string,
): Promise<{ expectedText: string; snapshot: SelectionSnapshot }> {
  const target = await locateVisibleToken(page, sessionId);
  await longPress(client, target.point);
  await expect
    .poll(() => readSelectionSnapshot(page), { timeout: 5_000 })
    .toMatchObject({
      anchor: target.range.anchor,
      focus: target.range.focus,
      handles: 2,
      toolbarVisible: true,
    });
  await expect(page.locator('[data-slot="pty-managed-selection-overlay"]')).toBeVisible();
  const snapshot = await readSelectionSnapshot(page);
  if (!snapshot) throw new Error("managed selection overlay did not mount after real long press");
  expect(snapshot.segments).toBeGreaterThan(0);
  return { expectedText: target.text, snapshot };
}

async function terminalRect(
  page: Page,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const box = await page.locator('[data-slot="pty-terminal"]').boundingBox();
  if (!box) throw new Error("PTY terminal has no bounding box");
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

async function tapPointAwayFromControls(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    if (!container) throw new Error("PTY terminal missing");
    const rect = container.getBoundingClientRect();
    const obstacles = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="pty-selection-handle"], [data-slot="pty-selection-toolbar"]',
      ),
      (element) => element.getBoundingClientRect(),
    );
    const candidates = [
      { x: rect.left + 28, y: rect.top + rect.height * 0.3 },
      { x: rect.right - 28, y: rect.top + rect.height * 0.3 },
      { x: rect.left + 28, y: rect.top + rect.height * 0.7 },
      { x: rect.right - 28, y: rect.top + rect.height * 0.7 },
    ];
    const distance = (point: Point, obstacle: DOMRect): number => {
      const dx = Math.max(obstacle.left - point.x, 0, point.x - obstacle.right);
      const dy = Math.max(obstacle.top - point.y, 0, point.y - obstacle.bottom);
      return Math.hypot(dx, dy);
    };
    return candidates.sort((left, right) => {
      const leftDistance = Math.min(...obstacles.map((obstacle) => distance(left, obstacle)));
      const rightDistance = Math.min(...obstacles.map((obstacle) => distance(right, obstacle)));
      return rightDistance - leftDistance;
    })[0];
  });
}

async function tapPointOutsideTerminal(page: Page): Promise<Point> {
  return page.locator('[data-slot="pty-terminal"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: Math.max(1, rect.top - 8),
    };
  });
}

test("touch selection survives real vertical and horizontal pans and copies the same token", async ({
  page,
}) => {
  const sessionId = "gate-managed-touch-pan";
  await prepareTerminal(page, sessionId);
  const client = await page.context().newCDPSession(page);
  let geometryProbeInstalled = false;
  try {
    const { expectedText, snapshot: initialSelection } = await establishSelection(
      page,
      client,
      sessionId,
    );
    const rect = await terminalRect(page);

    const beforeVertical = await readScrollPosition(page);
    await installHandleGeometryProbe(page);
    geometryProbeInstalled = true;
    await setHandleGeometryPhase(page, "active");
    const verticalStart = {
      x: rect.left + rect.width * 0.76,
      y: rect.top + rect.height * 0.36,
    };
    await touchPan(
      client,
      verticalStart,
      {
        x: verticalStart.x,
        y: verticalStart.y + Math.min(190, rect.height * 0.28),
      },
      {
        steps: 24,
        stepDelayMs: 12,
        settleMs: 900,
        onTouchEnd: () => setHandleGeometryPhase(page, "inertia"),
      },
    );
    const geometrySamples = await stopHandleGeometryProbe(page);
    geometryProbeInstalled = false;
    expectHandleGeometryAttached(geometrySamples, "active");
    expectHandleGeometryAttached(geometrySamples, "inertia");
    expectToolbarHiddenDuringActiveScroll(geometrySamples, beforeVertical.scrollTop);
    await expect
      .poll(async () => beforeVertical.scrollTop - (await readScrollPosition(page)).scrollTop)
      .toBeGreaterThan(40);
    await expect
      .poll(() => readSelectionSnapshot(page))
      .toMatchObject({
        anchor: initialSelection.anchor,
        focus: initialSelection.focus,
        handles: 2,
        toolbarVisible: true,
      });
    const toolbarAttachment = await readToolbarAttachment(page);
    expect(toolbarAttachment?.visibleHandles).toBeGreaterThan(0);
    expect(
      toolbarAttachment?.verticalGap,
      `settled toolbar was not re-anchored to the visible selection: ${JSON.stringify(toolbarAttachment)}`,
    ).toBeLessThanOrEqual(64);

    const beforeHorizontal = await readScrollPosition(page);
    await touchPan(
      client,
      { x: rect.left + rect.width * 0.82, y: rect.top + rect.height * 0.7 },
      { x: rect.left + rect.width * 0.18, y: rect.top + rect.height * 0.7 },
    );
    await expect
      .poll(async () => (await readScrollPosition(page)).scrollLeft - beforeHorizontal.scrollLeft)
      .toBeGreaterThan(40);
    await expect
      .poll(() => readSelectionSnapshot(page))
      .toMatchObject({
        anchor: initialSelection.anchor,
        focus: initialSelection.focus,
        handles: 2,
      });
    const horizontalToolbar = await readToolbarAttachment(page);
    if (horizontalToolbar) {
      expect(horizontalToolbar.visibleHandles).toBeGreaterThan(0);
      expect(horizontalToolbar.verticalGap).toBeLessThanOrEqual(64);
    }

    const afterHorizontal = await readScrollPosition(page);
    await touchPan(
      client,
      { x: rect.left + rect.width * 0.18, y: rect.top + rect.height * 0.7 },
      { x: rect.left + rect.width * 0.82, y: rect.top + rect.height * 0.7 },
    );
    await expect
      .poll(async () => afterHorizontal.scrollLeft - (await readScrollPosition(page)).scrollLeft)
      .toBeGreaterThan(40);
    await expect
      .poll(() => readSelectionSnapshot(page))
      .toMatchObject({
        anchor: initialSelection.anchor,
        focus: initialSelection.focus,
        handles: 2,
        toolbarVisible: true,
      });

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const copyButton = page.getByRole("button", { name: "复制终端选区" });
    const copyBox = await copyButton.boundingBox();
    if (!copyBox) throw new Error("copy button disappeared after real pans");
    await touchTap(client, {
      x: copyBox.x + copyBox.width / 2,
      y: copyBox.y + copyBox.height / 2,
    });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
  } finally {
    if (geometryProbeInstalled) await stopHandleGeometryProbe(page);
    await client.detach();
  }
});

test("a real touch drag moves one handle while a later light tap clears selection", async ({
  page,
}) => {
  const sessionId = "gate-managed-touch-handle";
  await prepareTerminal(page, sessionId);
  const client = await page.context().newCDPSession(page);
  try {
    const { snapshot: initialSelection } = await establishSelection(page, client, sessionId);
    const handle = page.locator('[data-slot="pty-selection-handle"][data-kind="focus"]');
    const terminalBox = await terminalRect(page);

    // Reveal the transient scrollbar while the focus handle overlaps its 32px hit area. The
    // handle must own this point; otherwise a real drag becomes a scrollbar track jump.
    await touchPan(
      client,
      {
        x: terminalBox.left + 48,
        y: terminalBox.top + terminalBox.height * 0.55,
      },
      {
        x: terminalBox.left + 48,
        y: terminalBox.top + terminalBox.height * 0.7,
      },
      { steps: 6, settleMs: 30 },
    );
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(1);
    const scrollbar = page.locator('[data-slot="pty-scrollbar"]');
    await expect(scrollbar).toHaveClass(/opacity-100/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const focusHandle = document.querySelector<HTMLElement>(
            '[data-slot="pty-selection-handle"][data-kind="focus"]',
          );
          if (!focusHandle) return null;
          const rect = focusHandle.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit
            ?.closest<HTMLElement>('[data-slot="pty-selection-handle"]')
            ?.getAttribute("data-kind");
        }),
      )
      .toBe("focus");

    const handleBox = await handle.boundingBox();
    const screenBox = await page.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
    if (!handleBox || !screenBox) throw new Error("focus handle or xterm screen is unavailable");
    const cellHeight = screenBox.height / ROWS;
    const start = {
      x: handleBox.x + handleBox.width / 2,
      y: handleBox.y + handleBox.height / 2,
    };
    const candidateDown = start.y + cellHeight * 3;
    const end = {
      x: Math.min(terminalBox.left + terminalBox.width - 32, start.x + 42),
      y:
        candidateDown < terminalBox.top + terminalBox.height - 50
          ? candidateDown
          : Math.max(terminalBox.top + 50, start.y - cellHeight * 3),
    };

    await touchPan(client, start, end, { steps: 10, settleMs: 180 });
    await expect
      .poll(() => readSelectionSnapshot(page), { timeout: 5_000 })
      .toMatchObject({ anchor: initialSelection.anchor, handles: 2, toolbarVisible: true });
    const moved = await readSelectionSnapshot(page);
    if (!moved) throw new Error("selection disappeared after real handle drag");
    expect(moved.focus).not.toEqual(initialSelection.focus);

    await touchTap(client, await tapPointAwayFromControls(page));
    await expect(page.locator('[data-slot="pty-selection-handle"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-managed-selection-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(0);

    await establishSelection(page, client, sessionId);
    const quickPanStart = {
      x: terminalBox.left + terminalBox.width * 0.75,
      y: terminalBox.top + terminalBox.height * 0.45,
    };
    await touchPan(
      client,
      quickPanStart,
      { x: quickPanStart.x, y: quickPanStart.y + 80 },
      { steps: 8, stepDelayMs: 8, settleMs: 0 },
    );
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(1);
    await touchTap(client, await tapPointOutsideTerminal(page));
    await expect(page.locator('[data-slot="pty-selection-handle"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-managed-selection-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(0);
    await page.waitForTimeout(250);
    await expect(page.locator('[data-slot="pty-selection-toolbar"]')).toHaveCount(0);
  } finally {
    await client.detach();
  }
});
