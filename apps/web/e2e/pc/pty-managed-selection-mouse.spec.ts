import { expect, test, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { sendPtyOutput } from "../pty-scroll-helpers";

test.use({ viewport: { width: 900, height: 640 } });
test.describe.configure({ retries: 0 });
test.setTimeout(90_000);

const OVERLAY_SELECTOR = '[data-slot="pty-managed-selection-overlay"]';
const TERMINAL_SELECTOR = '[data-slot="pty-terminal"]';
const XTERM_SCREEN_SELECTOR = '[data-slot="pty-host"] .xterm-screen';
const COPY_SHORTCUT = process.platform === "darwin" ? "Meta+C" : "Control+C";

interface RectSnapshot {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface TerminalDomSnapshot {
  readonly container: RectSnapshot;
  readonly screen: RectSnapshot;
  readonly review: RectSnapshot | null;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly maxScrollLeft: number;
  readonly maxScrollTop: number;
}

interface OverlayRangeSnapshot {
  readonly anchorRow: string;
  readonly anchorColumn: string;
  readonly focusRow: string;
  readonly focusColumn: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

async function readTerminalDom(page: Page): Promise<TerminalDomSnapshot | null> {
  return page.evaluate(
    ({ terminalSelector, screenSelector }) => {
      const container = document.querySelector<HTMLElement>(terminalSelector);
      const screen = document.querySelector<HTMLElement>(screenSelector);
      if (!container || !screen) return null;
      const containerRect = container.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const review = screen.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
      const reviewRect = review?.getBoundingClientRect() ?? null;
      const serializeRect = (rect: DOMRect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      return {
        container: serializeRect(containerRect),
        screen: serializeRect(screenRect),
        review: reviewRect ? serializeRect(reviewRect) : null,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        maxScrollLeft: Math.max(0, container.scrollWidth - container.clientWidth),
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      };
    },
    { terminalSelector: TERMINAL_SELECTOR, screenSelector: XTERM_SCREEN_SELECTOR },
  );
}

async function requireTerminalDom(page: Page): Promise<TerminalDomSnapshot> {
  const snapshot = await readTerminalDom(page);
  if (!snapshot) throw new Error("PTY terminal DOM is unavailable");
  return snapshot;
}

async function readOverlayRange(page: Page): Promise<OverlayRangeSnapshot | null> {
  return page.locator(OVERLAY_SELECTOR).evaluateAll((overlays) => {
    const overlay = overlays[0];
    if (!(overlay instanceof HTMLElement)) return null;
    const { anchorRow, anchorColumn, focusRow, focusColumn } = overlay.dataset;
    if (
      anchorRow === undefined ||
      anchorColumn === undefined ||
      focusRow === undefined ||
      focusColumn === undefined
    ) {
      return null;
    }
    return { anchorRow, anchorColumn, focusRow, focusColumn };
  });
}

async function requireOverlayRange(page: Page): Promise<OverlayRangeSnapshot> {
  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(1);
  const range = await readOverlayRange(page);
  if (!range) throw new Error("Managed selection overlay has no range dataset");
  return range;
}

function expectSameAnchor(before: OverlayRangeSnapshot, after: OverlayRangeSnapshot): void {
  expect({ row: after.anchorRow, column: after.anchorColumn }).toEqual({
    row: before.anchorRow,
    column: before.anchorColumn,
  });
}

function expectChangedFocus(before: OverlayRangeSnapshot, after: OverlayRangeSnapshot): void {
  expect(`${after.focusRow}:${after.focusColumn}`).not.toBe(
    `${before.focusRow}:${before.focusColumn}`,
  );
}

async function setupHistory(
  page: Page,
  sessionId: string,
  options: { cols?: number; lines?: number } = {},
): Promise<void> {
  const cols = options.cols ?? 160;
  const lines = options.lines ?? 440;
  await setupPtyChat(page, { sessionId, cols, rows: 24 });
  await expectPtyTerminalMounted(page, { timeout: 10_000 });

  const output = Array.from({ length: lines }, (_, index) => {
    const row = String(index).padStart(4, "0");
    return `MANAGED ${sessionId} ROW ${row} | ${"0123456789".repeat(8)} | END ${row}\r\n`;
  }).join("");
  await sendPtyOutput(page, output);

  await expect
    .poll(async () => (await readTerminalDom(page))?.maxScrollTop ?? 0)
    .toBeGreaterThan(1_000);
  await expect
    .poll(() =>
      page
        .locator(`${XTERM_SCREEN_SELECTOR} .xterm-rows`)
        .allTextContents()
        .then((contents) => contents.join("\n")),
    )
    .toContain(`END ${String(lines - 1).padStart(4, "0")}`);
}

async function enterReview(page: Page, deltaY: number): Promise<TerminalDomSnapshot> {
  const before = await requireTerminalDom(page);
  await page.mouse.move(
    before.container.left + before.container.width / 2,
    before.container.top + before.container.height / 2,
  );
  await page.mouse.wheel(0, deltaY);
  await expect
    .poll(async () => (await requireTerminalDom(page)).scrollTop)
    .toBeLessThan(before.scrollTop - 40);
  await expect(page.locator('[data-slot="pty-review-snapshot"]')).toBeVisible();
  await expect
    .poll(async () => {
      const snapshot = await requireTerminalDom(page);
      return snapshot.screen.top - snapshot.container.top;
    })
    .toBeGreaterThan(40);
  return requireTerminalDom(page);
}

function liveScreenY(geometry: TerminalDomSnapshot): number {
  const top = Math.max(geometry.container.top + 36, geometry.screen.top + 18);
  const bottom = Math.min(geometry.container.bottom - 36, geometry.screen.bottom - 18);
  if (bottom <= top) {
    throw new Error(
      `Live xterm screen does not intersect the safe viewport: ${JSON.stringify(geometry)}`,
    );
  }
  return (top + bottom) / 2;
}

async function copyManagedSelection(page: Page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const sentinel = `__selection_clipboard_sentinel_${Date.now()}__`;
  await page.evaluate((value) => navigator.clipboard.writeText(value), sentinel);
  const rawInputBeforeCopy = await readRawPtyInput(page);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(sentinel);
  expect(await readRawPtyInput(page)).toBe(rawInputBeforeCopy);
  return page.evaluate(() => navigator.clipboard.readText());
}

async function clearSelectionWithClick(page: Page): Promise<void> {
  const geometry = await requireTerminalDom(page);
  await page.mouse.click(
    geometry.container.left + geometry.container.width / 2,
    geometry.container.top + geometry.container.height / 2,
  );
  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0);
}

async function stationaryMouseHold(
  page: Page,
  point: Point,
  surface: "projection" | "xterm",
): Promise<void> {
  const geometry = await requireTerminalDom(page);
  if (surface === "projection") {
    expect(geometry.review).not.toBeNull();
    expect(point.x).toBeGreaterThan(geometry.review!.left);
    expect(point.x).toBeLessThan(geometry.review!.right);
    expect(point.y).toBeGreaterThan(geometry.review!.top);
    expect(point.y).toBeLessThan(geometry.review!.bottom);
  } else {
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest(".xterm") !== null,
        point,
      ),
    ).toBe(true);
  }

  expect(await readOverlayRange(page)).toBeNull();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await page.waitForTimeout(1_000);
    const during = await requireTerminalDom(page);
    expect(during.scrollTop).toBeCloseTo(geometry.scrollTop, 1);
    expect(during.scrollLeft).toBeCloseTo(geometry.scrollLeft, 1);
    expect(await readOverlayRange(page)).toBeNull();
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0);
}

async function dragSelectionAcrossVerticalViewport(
  page: Page,
  direction: "up" | "down",
): Promise<void> {
  let geometry = await requireTerminalDom(page);
  const x = geometry.container.left + Math.min(260, geometry.container.width / 2);
  const startY = liveScreenY(geometry);
  const directionSign = direction === "up" ? -1 : 1;

  await page.mouse.move(x, startY);
  await page.mouse.down();
  try {
    await page.mouse.move(x, startY + directionSign * 48, { steps: 6 });
    const initialRange = await requireOverlayRange(page);
    geometry = await requireTerminalDom(page);
    await page.mouse.move(
      x,
      direction === "up" ? geometry.container.top + 2 : geometry.container.bottom - 2,
      { steps: 8 },
    );
    const edgeStart = await requireTerminalDom(page);
    const minimumDistance = Math.floor(edgeStart.container.height);
    const availableDistance =
      direction === "up" ? edgeStart.scrollTop : edgeStart.maxScrollTop - edgeStart.scrollTop;
    expect(availableDistance).toBeGreaterThan(minimumDistance + 40);
    await expect
      .poll(
        async () => {
          const current = await requireTerminalDom(page);
          return direction === "up"
            ? edgeStart.scrollTop - current.scrollTop
            : current.scrollTop - edgeStart.scrollTop;
        },
        { timeout: 6_000 },
      )
      .toBeGreaterThan(minimumDistance);
    const autoscrolledRange = await requireOverlayRange(page);
    expectSameAnchor(initialRange, autoscrolledRange);
    expectChangedFocus(initialRange, autoscrolledRange);
  } finally {
    await page.mouse.up();
  }
}

async function dragSelectionHorizontally(page: Page, direction: "left" | "right"): Promise<void> {
  let geometry = await requireTerminalDom(page);
  const y = liveScreenY(geometry);
  const startX =
    geometry.container.left + geometry.container.width * (direction === "right" ? 0.38 : 0.62);
  const directionSign = direction === "left" ? -1 : 1;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  try {
    await page.mouse.move(startX + directionSign * 48, y, { steps: 6 });
    const initialRange = await requireOverlayRange(page);
    geometry = await requireTerminalDom(page);
    await page.mouse.move(
      direction === "left" ? geometry.container.left + 2 : geometry.container.right - 2,
      y,
      { steps: 8 },
    );
    const edgeStart = await requireTerminalDom(page);
    const availableDistance =
      direction === "left" ? edgeStart.scrollLeft : edgeStart.maxScrollLeft - edgeStart.scrollLeft;
    expect(availableDistance).toBeGreaterThan(100);
    await expect
      .poll(
        async () => {
          const current = await requireTerminalDom(page);
          return direction === "left"
            ? edgeStart.scrollLeft - current.scrollLeft
            : current.scrollLeft - edgeStart.scrollLeft;
        },
        { timeout: 4_000 },
      )
      .toBeGreaterThan(60);
    const autoscrolledRange = await requireOverlayRange(page);
    expectSameAnchor(initialRange, autoscrolledRange);
    expectChangedFocus(initialRange, autoscrolledRange);
  } finally {
    await page.mouse.up();
  }
}

test("a stationary mouse hold cannot start selection autoscroll", async ({ page }) => {
  await setupHistory(page, "gate-managed-stationary");
  const geometry = await enterReview(page, -900);
  const x = geometry.container.left + Math.min(260, geometry.container.width / 2);
  if (!geometry.review) throw new Error("review projection is unavailable");

  await stationaryMouseHold(
    page,
    { x, y: geometry.review.top + Math.min(12, geometry.review.height / 2) },
    "projection",
  );
  await stationaryMouseHold(page, { x, y: geometry.screen.top + 5 }, "xterm");
});

test("vertical edge selection crosses a viewport, freezes after release, and clears on click", async ({
  page,
}) => {
  await setupHistory(page, "gate-managed-vertical");
  const initial = await requireTerminalDom(page);
  await enterReview(page, -Math.ceil(initial.container.height * 3));
  await dragSelectionAcrossVerticalViewport(page, "up");
  await clearSelectionWithClick(page);

  let geometry = await requireTerminalDom(page);
  await page.mouse.move(
    geometry.container.left + geometry.container.width / 2,
    geometry.container.top + geometry.container.height / 2,
  );
  await page.mouse.wheel(0, 10_000);
  await expect
    .poll(async () => {
      const current = await requireTerminalDom(page);
      return current.maxScrollTop - current.scrollTop;
    })
    .toBeLessThan(2);
  geometry = await requireTerminalDom(page);
  await enterReview(page, -Math.ceil(geometry.container.height * 3));
  await dragSelectionAcrossVerticalViewport(page, "down");

  const committedRange = await requireOverlayRange(page);
  const copiedBeforeWheel = await copyManagedSelection(page);
  expect(copiedBeforeWheel).toMatch(/MANAGED gate-managed-vertical ROW \d{4}/u);

  geometry = await requireTerminalDom(page);
  const wheelDelta = geometry.scrollTop > geometry.maxScrollTop / 2 ? -320 : 320;
  const scrollTopBeforeWheel = geometry.scrollTop;
  await page.mouse.move(
    geometry.container.left + geometry.container.width / 2,
    geometry.container.top + geometry.container.height / 2,
  );
  await page.mouse.wheel(0, wheelDelta);
  await expect
    .poll(async () => Math.abs((await requireTerminalDom(page)).scrollTop - scrollTopBeforeWheel))
    .toBeGreaterThan(40);
  expect(await requireOverlayRange(page)).toEqual(committedRange);
  expect(await copyManagedSelection(page)).toBe(copiedBeforeWheel);

  await clearSelectionWithClick(page);
});

test("horizontal edge selection autoscrolls right and left with a fixed anchor", async ({
  page,
}) => {
  await setupHistory(page, "gate-managed-horizontal", { cols: 160, lines: 260 });
  const geometry = await requireTerminalDom(page);
  expect(geometry.maxScrollLeft).toBeGreaterThan(300);

  await dragSelectionHorizontally(page, "right");
  const copiedRight = await copyManagedSelection(page);
  expect(copiedRight.length).toBeGreaterThan(20);
  expect(copiedRight).toContain("0123456789");
  await clearSelectionWithClick(page);

  await dragSelectionHorizontally(page, "left");
  const copiedLeft = await copyManagedSelection(page);
  expect(copiedLeft.length).toBeGreaterThan(20);
  expect(copiedLeft).toContain("0123456789");
  await clearSelectionWithClick(page);
});

test("a selection on the frozen top frame follows scrollback trim without changing text", async ({
  page,
}) => {
  const sessionId = "gate-managed-trim-identity";
  await setupHistory(page, sessionId, { cols: 160, lines: 5_200 });
  let geometry = await requireTerminalDom(page);
  await page.mouse.move(
    geometry.container.left + geometry.container.width / 2,
    geometry.container.top + geometry.container.height / 2,
  );
  await page.mouse.wheel(0, -100_000);
  const initialViewportY = await expect
    .poll(() =>
      page.evaluate(
        (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.viewportY ?? -1,
        sessionId,
      ),
    )
    .toBeLessThan(24)
    .then(() =>
      page.evaluate(
        (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.viewportY ?? -1,
        sessionId,
      ),
    );
  expect(initialViewportY).toBeGreaterThanOrEqual(0);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toBeVisible();
  const frozenText = await snapshot.textContent();
  geometry = await requireTerminalDom(page);
  const target = await snapshot.locator(".xterm-rows > div").evaluateAll((rows, containerRect) => {
    const visibleRows = rows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        const label = row.textContent?.match(/MANAGED gate-managed-trim-identity ROW \d{4}/u)?.[0];
        return label
          ? { label, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          : null;
      })
      .filter(
        (
          row,
        ): row is {
          label: string;
          left: number;
          top: number;
          right: number;
          bottom: number;
        } =>
          row !== null &&
          row.top >= containerRect.top + 8 &&
          row.bottom <= containerRect.bottom - 8,
      );
    return visibleRows[Math.max(0, visibleRows.length - 4)] ?? null;
  }, geometry.container);
  if (!target) throw new Error("No stable frozen history row is visible at the top of scrollback");

  const y = (target.top + target.bottom) / 2;
  await page.mouse.move(target.left + 4, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(target.right - 4, target.left + 100), y, { steps: 8 });
  await page.mouse.up();
  const beforeRange = await requireOverlayRange(page);
  const copiedBeforeTrim = await copyManagedSelection(page);
  expect(copiedBeforeTrim).toContain("MANAGED");

  const trimCount = initialViewportY + 3;
  const trimOutput = Array.from(
    { length: trimCount },
    (_, index) => `TRIM IDENTITY ${String(index + 1).padStart(2, "0")}\r\n`,
  ).join("");
  await sendPtyOutput(page, trimOutput);
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
    .toContain(`TRIM IDENTITY ${String(trimCount).padStart(2, "0")}`);
  await expect
    .poll(() =>
      page.evaluate(
        (sid) => window.__ccTestPtyTerminals?.get(sid)?.buffer.active.viewportY ?? -1,
        sessionId,
      ),
    )
    .toBe(0);
  await expect(snapshot).toHaveText(frozenText ?? "");

  const currentTargetRow = await page.evaluate(
    ({ sid, label }) => {
      const terminal = window.__ccTestPtyTerminals?.get(sid);
      if (!terminal) return -1;
      for (let row = 0; row < terminal.buffer.active.length; row += 1) {
        if (terminal.buffer.active.getLine(row)?.translateToString(true).includes(label))
          return row;
      }
      return -1;
    },
    { sid: sessionId, label: target.label },
  );
  expect(currentTargetRow).toBeGreaterThanOrEqual(0);
  await expect
    .poll(async () => Number((await requireOverlayRange(page)).anchorRow))
    .toBe(currentTargetRow);

  const afterRange = await requireOverlayRange(page);
  const rowDelta = currentTargetRow - Number(beforeRange.anchorRow);
  expect(rowDelta).toBeLessThan(0);
  expect(Number(afterRange.focusRow) - Number(beforeRange.focusRow)).toBe(rowDelta);
  expect(await copyManagedSelection(page)).toBe(copiedBeforeTrim);
});
