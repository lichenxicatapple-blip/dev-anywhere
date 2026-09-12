import { expect, type Page, type TestInfo } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "./pty-fixture";
import {
  ptyInput,
  ptyTerminal,
  readPtyHorizontalScrollMetrics,
  readPtyScrollMetrics,
  sendPtyOutput,
} from "./pty-scroll-helpers";

export async function verifyManualHorizontalReview(
  page: Page,
  testInfo: TestInfo,
  options: { baseUrl?: string; pan?: () => Promise<void> } = {},
) {
  const sessionId = "pty-partial-horizontal-review";
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "codex",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 29,
    snapshotData: `\x1b[?25h\x1b[26;1H> ${"x".repeat(60)}`,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  await expectPtyTerminalMounted(page);
  await expect
    .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.scrollLeft))
    .toBeGreaterThan(100);
  const initial = await readPtyHorizontalScrollMetrics(page);
  await testInfo.attach("before-partial-pan", {
    body: JSON.stringify(initial),
    contentType: "application/json",
  });

  if (options.pan) await options.pan();
  else {
    await ptyTerminal(page).hover();
    await page.mouse.wheel(-120, 0);
  }
  await expect
    .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.scrollLeft))
    .toBeLessThan(initial.scrollLeft - 80);
  const reviewLeft = (await readPtyHorizontalScrollMetrics(page)).scrollLeft;
  expect(reviewLeft).toBeGreaterThan(100);
  const geometry = await page.evaluate((id) => {
    const term = window.__ccTestPtyTerminals!.get(id)!;
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]')!;
    const screen = container.querySelector<HTMLElement>(".xterm-screen")!;
    const cursorPx = term.buffer.active.cursorX * (screen.clientWidth / term.cols);
    return {
      cursorPx,
      cellW: screen.clientWidth / term.cols,
      left: container.scrollLeft,
      right: container.scrollLeft + container.clientWidth,
    };
  }, sessionId);
  expect(geometry.cursorPx).toBeGreaterThan(geometry.left);
  expect(geometry.cursorPx).toBeLessThan(geometry.right);
  expect(geometry.cursorPx).toBeGreaterThanOrEqual(geometry.right - 8 * geometry.cellW);

  // Replay independent background frames, including cursor movements. The user only panned;
  // neither passive paints nor remote cursor activity should return ownership to auto-follow.
  const positions: number[] = [];
  for (const column of [62, 63, 61, 62]) {
    await sendPtyOutput(page, `\x1b[1;1Hstatus ${column}\x1b[26;${column + 1}H`);
    // Keep painting past the former touch grace window, without advancing the terminal by
    // local input. A transient touch lock alone would pass a check made immediately on release.
    await page.evaluate(async (id) => {
      const term = window.__ccTestPtyTerminals!.get(id)!;
      for (let paint = 0; paint < 20; paint += 1) {
        term.refresh(0, term.rows - 1);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, sessionId);
    positions.push((await readPtyHorizontalScrollMetrics(page)).scrollLeft);
  }
  await testInfo.attach("partial-pan-background-positions", {
    body: JSON.stringify({ reviewLeft, positions, geometry }),
    contentType: "application/json",
  });
  expect(positions.every((left) => Math.abs(left - reviewLeft) <= 1)).toBe(true);

  await ptyTerminal(page).click();
  await page.keyboard.type("y");
  await sendPtyOutput(page, "\x1b[26;64H");
  await expect
    .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.scrollLeft))
    .toBeGreaterThan(reviewLeft + 50);
}

export async function verifyHiddenCursorRedraw(page: Page, testInfo: TestInfo, baseUrl?: string) {
  const sessionId = "pty-hidden-paint-cursor";
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "kimi",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 29,
    snapshotData: "\x1b[?25l\x1b[26;1Hinput\x1b[26;6H",
    ...(baseUrl ? { baseUrl } : {}),
  });
  await expectPtyTerminalMounted(page);
  await expect
    .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.maxScrollLeft))
    .toBeGreaterThan(100);

  // Capture every assignment, including movements reversed before the browser's scroll event.
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]')!;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
    const samples: number[] = [];
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      get: () => descriptor.get!.call(container) as number,
      set: (value: number) => {
        descriptor.set!.call(container, value);
        samples.push(container.scrollLeft);
      },
    });
    Object.assign(window, { __cursorRedrawScrollSamples: samples });
  });

  // Kimi 0.42 draws a row up to column 79, ends synchronized output, then separately
  // positions its hidden hardware cursor for the software caret / IME. Force several browser
  // paints between those chunks: success must not depend on the two packets arriving together.
  for (let redraw = 0; redraw < 3; redraw += 1) {
    await sendPtyOutput(page, `\x1b[?2026h\x1b[24;1H${"-".repeat(79)}\x1b[?2026l`);
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__ccTestPtyTerminals?.get(id)?.buffer.active.cursorX,
          sessionId,
        ),
      )
      .toBe(79);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await sendPtyOutput(page, "\x1b[2B");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await sendPtyOutput(page, "\x1b[6G\x1b[?25l");
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__ccTestPtyTerminals?.get(id)?.buffer.active.cursorX,
          sessionId,
        ),
      )
      .toBe(5);
  }
  const samples = await page.evaluate(
    () =>
      (window as unknown as { __cursorRedrawScrollSamples: number[] }).__cursorRedrawScrollSamples,
  );
  await testInfo.attach("scroll-left-assignments", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  expect(samples.filter((left) => left > 1)).toEqual([]);

  // A hidden hardware cursor still represents the input position in software-cursor TUIs.
  // It must follow long input, with cursor positioning both outside and inside the sync block.
  for (const positionInsideRedraw of [false, true]) {
    const position = "\x1b[26;61H";
    await sendPtyOutput(
      page,
      `\x1b[?2026h\x1b[26;1H${"x".repeat(79)}${positionInsideRedraw ? position : ""}\x1b[?2026l${positionInsideRedraw ? "" : position}\x1b[?25l`,
    );
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.scrollLeft))
      .toBeGreaterThan(100);
    await sendPtyOutput(page, "\x1b[6G\x1b[?25l");
    await expect
      .poll(() => readPtyHorizontalScrollMetrics(page).then((m) => m.scrollLeft))
      .toBeLessThanOrEqual(1);
  }
}

export async function verifyVerticalCursorRedraw(
  page: Page,
  testInfo: TestInfo,
  options: { baseUrl?: string; rows?: number; openKeyboard?: () => Promise<void> } = {},
) {
  const sessionId = "pty-vertical-paint-cursor";
  const rows = options.rows ?? 32;
  const inputRow = rows - 3;
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "kimi",
    ptyOwner: "proxy-hosted",
    cols: 113,
    rows,
    withVisualViewportMock: options.openKeyboard === undefined,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    snapshotData:
      "\r\n".repeat(2860) +
      Array.from({ length: rows }, (_, row) => `\x1b[${row + 1};1Hscreen row ${row}`).join("") +
      `\x1b[?25l\x1b[${inputRow};6H`,
  });
  await expectPtyTerminalMounted(page);
  if (options.openKeyboard) await options.openKeyboard();
  else {
    await ptyTerminal(page).click();
    await ptyInput(page).focus();
    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({ height: 436.6, offsetTop: 0 }),
    );
  }
  await expect(page.locator('[data-slot="pty-mobile-controls"]')).toBeVisible();
  // Android may pan visualViewport instead of shrinking the DOM container. In either layout,
  // require the same relevant geometry: the paint row is above the viewport's live bottom.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.__devAnywherePtyDebug!()!;
        return (
          snapshot.term.rows * snapshot.cell.h -
          snapshot.visibleContentHeight -
          12 * snapshot.cell.h
        );
      }),
    )
    .toBeGreaterThan(100);
  const settlePaints = () =>
    page.evaluate(async () => {
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
  await settlePaints();
  const before = await readPtyScrollMetrics(page);

  // A shrinking spacer makes the browser clamp scrollTop without a controller assignment.
  // Sample actual paints and native scroll events, not just writes to scrollTop.
  await page.evaluate((id) => {
    const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]')!;
    const samples: Array<{ top: number; height: number; cursorY: number }> = [];
    const term = window.__ccTestPtyTerminals!.get(id)!;
    const record = () =>
      samples.push({
        top: container.scrollTop,
        height: container.scrollHeight,
        cursorY: term.buffer.active.cursorY,
      });
    container.addEventListener("scroll", record);
    term.onRender(record);
    const paint = () => {
      if (!container.isConnected) return;
      record();
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    Object.assign(window, { __verticalRedrawSamples: samples });
  }, sessionId);

  for (let redraw = 0; redraw < 3; redraw += 1) {
    // At 32 rows this reproduces the reported row 28 -> 12 -> 28 sequence, with packets after
    // synchronized output ends. Holding each state across paints exposes transient clamping.
    await sendPtyOutput(page, "\x1b[?2026h\x1b[13;1Hpainting....\x1b[?2026l");
    await settlePaints();
    await sendPtyOutput(page, `\x1b[${inputRow - 13}B\x1b[6G\x1b[?25l`);
    await settlePaints();
  }
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          __verticalRedrawSamples: Array<{ top: number; height: number; cursorY: number }>;
        }
      ).__verticalRedrawSamples,
  );
  await testInfo.attach("vertical-redraw-geometry", {
    body: JSON.stringify({ before, samples }),
    contentType: "application/json",
  });
  expect(samples.some((sample) => sample.cursorY === 12)).toBe(true);
  expect(samples.every((sample) => Math.abs(sample.top - before.scrollTop) <= 1)).toBe(true);
  expect(samples.every((sample) => sample.height === before.scrollHeight)).toBe(true);

  // A real caret move to the upper input row must still make that row visible.
  await sendPtyOutput(page, "\x1b[13;6H");
  await expect
    .poll(() => readPtyScrollMetrics(page).then((m) => m.scrollTop))
    .toBeLessThan(before.scrollTop - 100);
  await sendPtyOutput(page, `\x1b[${inputRow};6H`);
  await expect
    .poll(() => readPtyScrollMetrics(page).then((m) => m.scrollTop))
    .toBeCloseTo(before.scrollTop, 0);
}
