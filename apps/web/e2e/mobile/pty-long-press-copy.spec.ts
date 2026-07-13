// 真 Android Chrome: PTY 是 xterm 渲染层,不能依赖浏览器原生 DOM 文本选择。
// 移动端长按应走 DEV Anywhere 自己的 xterm buffer 选区, 支持拖拽范围和边缘自动滚动。
import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-pty-long-press-copy";
const execFileAsync = promisify(execFile);
const edgeAutoscrollDiagnosticTest =
  process.env.TEST_MOBILE_EDGE_AUTOSCROLL_DIAGNOSTICS === "1" ? test : test.skip;

declare global {
  interface Window {
    __mobilePtyCopiedText?: string;
    __ccTestPtySelectionControllers?: Map<
      string,
      {
        selectRange: (options: {
          anchorRow: number;
          focusRow: number;
          anchorColumn?: number;
          focusColumn?: number;
        }) => boolean;
        clear: () => void;
      }
    >;
  }
}

interface SelectionOverlayGeometry {
  visualBottom: number;
  visualRight: number;
  toolbar: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } | null;
  handles: Array<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    centerX: number;
    centerY: number;
  }>;
}

async function readSelectionOverlayGeometry(page: Page): Promise<SelectionOverlayGeometry> {
  return page.evaluate(() => {
    const rectOf = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    const handles = Array.from(
      document.querySelectorAll('[data-slot="pty-selection-handle"]'),
      (el) => {
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        };
      },
    );
    return {
      visualBottom: window.visualViewport?.height ?? window.innerHeight,
      visualRight: window.visualViewport?.width ?? window.innerWidth,
      toolbar: rectOf('[data-slot="pty-selection-toolbar"]'),
      handles,
    };
  });
}

function getSelectionOverlayAttachmentError(geometry: SelectionOverlayGeometry): string | null {
  if (!geometry.toolbar) return "selection toolbar missing";
  if (geometry.handles.length !== 2) return `expected 2 handles, got ${geometry.handles.length}`;
  if (geometry.toolbar.top < 0) return `toolbar top ${geometry.toolbar.top} is above viewport`;
  if (geometry.toolbar.bottom > geometry.visualBottom + 2) {
    return `toolbar bottom ${geometry.toolbar.bottom} is below visual viewport ${geometry.visualBottom}`;
  }

  for (const handle of geometry.handles) {
    if (handle.centerX < 0 || handle.centerX > geometry.visualRight) {
      return `handle centerX ${handle.centerX} is outside visual viewport ${geometry.visualRight}`;
    }
    if (handle.centerY < 0 || handle.centerY > geometry.visualBottom) {
      return `handle centerY ${handle.centerY} is outside visual viewport ${geometry.visualBottom}`;
    }
  }

  const handleTop = Math.min(...geometry.handles.map((handle) => handle.top));
  const handleBottom = Math.max(...geometry.handles.map((handle) => handle.bottom));
  const verticalGap =
    geometry.toolbar.bottom < handleTop
      ? handleTop - geometry.toolbar.bottom
      : geometry.toolbar.top > handleBottom
        ? geometry.toolbar.top - handleBottom
        : 0;
  const handleCenterX = geometry.handles.reduce((sum, handle) => sum + handle.centerX, 0) / 2;
  const toolbarCenterX = (geometry.toolbar.left + geometry.toolbar.right) / 2;

  if (verticalGap > 96) return `toolbar/handle vertical gap ${verticalGap} exceeds 96`;
  if (Math.abs(toolbarCenterX - handleCenterX) > 160) {
    return `toolbar/handle horizontal gap ${Math.abs(toolbarCenterX - handleCenterX)} exceeds 160`;
  }
  return null;
}

async function expectSelectionOverlayAttachedEventually(page: Page): Promise<void> {
  await expect
    .poll(
      async () => getSelectionOverlayAttachmentError(await readSelectionOverlayGeometry(page)),
      {
        timeout: 5_000,
      },
    )
    .toBeNull();
}

async function waitForVisualViewportStable(page: Page): Promise<void> {
  let stableSamples = 0;
  let previous: { height: number; offsetTop: number } | null = null;
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const current = await page.evaluate(() => ({
      height: window.visualViewport?.height ?? window.innerHeight,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
    }));
    if (
      previous &&
      Math.abs(current.height - previous.height) < 0.5 &&
      Math.abs(current.offsetTop - previous.offsetTop) < 0.5
    ) {
      stableSamples += 1;
      if (stableSamples >= 3) return;
    } else {
      stableSamples = 0;
    }
    previous = current;
    await page.waitForTimeout(80);
  }
}

function getOverlayCenter(geometry: SelectionOverlayGeometry): {
  toolbarX: number;
  toolbarY: number;
  handlesX: number;
  handlesY: number;
} | null {
  if (!geometry.toolbar || geometry.handles.length !== 2) return null;
  return {
    toolbarX: (geometry.toolbar.left + geometry.toolbar.right) / 2,
    toolbarY: (geometry.toolbar.top + geometry.toolbar.bottom) / 2,
    handlesX: geometry.handles.reduce((sum, handle) => sum + handle.centerX, 0) / 2,
    handlesY: geometry.handles.reduce((sum, handle) => sum + handle.centerY, 0) / 2,
  };
}

function formatOverlaySamples(samples: SelectionOverlayGeometry[]): string {
  return samples
    .map((geometry, index) => {
      const center = getOverlayCenter(geometry);
      if (!center) return `${index}: missing`;
      return `${index}: toolbar=(${center.toolbarX.toFixed(1)},${center.toolbarY.toFixed(1)}) handles=(${center.handlesX.toFixed(1)},${center.handlesY.toFixed(1)}) vv=${geometry.visualBottom.toFixed(1)}`;
    })
    .join("; ");
}

async function expectSelectionOverlayStable(page: Page): Promise<void> {
  await waitForVisualViewportStable(page);
  await expectSelectionOverlayAttachedEventually(page);
  const samples: SelectionOverlayGeometry[] = [];
  for (let index = 0; index < 8; index += 1) {
    const geometry = await readSelectionOverlayGeometry(page);
    const error = getSelectionOverlayAttachmentError(geometry);
    if (error)
      throw new Error(`selection overlay detached during stability sample ${index}: ${error}`);
    samples.push(geometry);
    await page.waitForTimeout(100);
  }

  let maxToolbarJump = 0;
  let maxHandleJump = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = getOverlayCenter(samples[index - 1]);
    const current = getOverlayCenter(samples[index]);
    if (!previous || !current)
      throw new Error(`selection overlay geometry missing at sample ${index}`);
    maxToolbarJump = Math.max(
      maxToolbarJump,
      Math.hypot(current.toolbarX - previous.toolbarX, current.toolbarY - previous.toolbarY),
    );
    maxHandleJump = Math.max(
      maxHandleJump,
      Math.hypot(current.handlesX - previous.handlesX, current.handlesY - previous.handlesY),
    );
  }

  expect(
    maxToolbarJump,
    `toolbar jumped ${maxToolbarJump}px while selection was idle; ${formatOverlaySamples(samples)}`,
  ).toBeLessThan(24);
  expect(
    maxHandleJump,
    `handles jumped ${maxHandleJump}px while selection was idle; ${formatOverlaySamples(samples)}`,
  ).toBeLessThan(24);
}

async function longPress(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number } = start,
  options: { holdBeforeMoveMs?: number; holdAfterMoveMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    async ({ startPoint, endPoint, holdBeforeMoveMs, holdAfterMoveMs }) => {
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const pointerId = 9001;
      const target = document.elementFromPoint(startPoint.x, startPoint.y) ?? document.body;
      const dispatch = (
        type: "pointerdown" | "pointermove" | "pointerup",
        point: { x: number; y: number },
      ) => {
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: point.x,
            clientY: point.y,
            width: 4,
            height: 4,
            pressure: type === "pointerup" ? 0 : 0.5,
          }),
        );
      };

      dispatch("pointerdown", startPoint);
      await sleep(holdBeforeMoveMs ?? 900);
      if (endPoint.x !== startPoint.x || endPoint.y !== startPoint.y) {
        const steps = 8;
        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          dispatch("pointermove", {
            x: startPoint.x + (endPoint.x - startPoint.x) * progress,
            y: startPoint.y + (endPoint.y - startPoint.y) * progress,
          });
          await sleep(40);
        }
        await sleep(holdAfterMoveMs ?? 100);
      }
      dispatch("pointerup", endPoint);
    },
    {
      startPoint: start,
      endPoint: end,
      holdBeforeMoveMs: options.holdBeforeMoveMs,
      holdAfterMoveMs: options.holdAfterMoveMs,
    },
  );
}

async function pointerTap(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.evaluate(async (tapPoint) => {
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const target = document.elementFromPoint(tapPoint.x, tapPoint.y) ?? document.body;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 9002,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: tapPoint.x,
      clientY: tapPoint.y,
      width: 4,
      height: 4,
    } satisfies PointerEventInit;
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...eventInit, buttons: 1, pressure: 0.5 }),
    );
    await sleep(50);
    target.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0, pressure: 0 }));
  }, point);
}

async function touchTap(page: Page, point: { x: number; y: number }): Promise<void> {
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
  options: { holdAfterMoveMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    async ({ startPoint, endPoint, holdAfterMoveMs }) => {
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const target = document.elementFromPoint(startPoint.x, startPoint.y) ?? document.body;
      const makeTouch = (point: { x: number; y: number }) =>
        new Touch({
          identifier: 1,
          target,
          clientX: point.x,
          clientY: point.y,
          radiusX: 3,
          radiusY: 3,
          force: 0.5,
        });
      const startTouch = makeTouch(startPoint);
      target.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [startTouch],
          targetTouches: [startTouch],
          changedTouches: [startTouch],
        }),
      );
      await sleep(80);
      const moveTouch = makeTouch(endPoint);
      window.dispatchEvent(
        new TouchEvent("touchmove", {
          bubbles: true,
          cancelable: true,
          touches: [moveTouch],
          targetTouches: [moveTouch],
          changedTouches: [moveTouch],
        }),
      );
      await sleep(holdAfterMoveMs ?? 120);
      window.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [moveTouch],
        }),
      );
    },
    { startPoint: start, endPoint: end, holdAfterMoveMs: options.holdAfterMoveMs },
  );
}

async function readTerminalSelection(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", sessionId);
}

async function waitForSelectionToContain(
  page: Page,
  sessionId: string,
  expectedTexts: string[],
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let selection = "";
  while (Date.now() < deadline) {
    selection = await readTerminalSelection(page, sessionId);
    if (expectedTexts.every((text) => selection.includes(text))) return selection;
    await page.waitForTimeout(80);
  }
  throw new Error(
    `selection did not contain expected text; expected=${JSON.stringify(expectedTexts)} actual=${JSON.stringify(selection)}`,
  );
}

async function expectSelectionClearedByOutsideTap(
  page: Page,
  points: Array<{ x: number; y: number }>,
) {
  const copyButton = page.getByRole("button", { name: "复制终端选区" });
  const endHandle = page.getByRole("button", { name: "调整选区终点" });
  let lastVisible = true;
  for (const point of points) {
    await pointerTap(page, point);
    await page.waitForTimeout(160);
    lastVisible = await copyButton.isVisible().catch(() => false);
    if (!lastVisible) break;
  }
  expect(
    lastVisible,
    `selection toolbar stayed visible after outside taps ${JSON.stringify(points)}`,
  ).toBe(false);
  await expect(copyButton).toBeHidden();
  await expect(endHandle).toBeHidden();
}

async function selectVisibleTerminalRowsWithTestDriver(
  page: Page,
  sessionId: string,
  target: {
    startRowInViewport: number;
    endRowInViewport: number;
    endText: string;
  },
  expectedTexts: string[],
): Promise<void> {
  const selected = await page.evaluate(
    ({ sid, range }) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const controller = window.__ccTestPtySelectionControllers?.get(sid);
      if (!term || !controller) return false;
      const anchorRow = term.buffer.active.viewportY + range.startRowInViewport;
      const focusRow = term.buffer.active.viewportY + range.endRowInViewport;
      return controller.selectRange({
        anchorRow,
        focusRow,
        anchorColumn: 0,
        focusColumn: Math.max(0, Math.min(range.endText.length - 1, term.cols - 1)),
      });
    },
    { sid: sessionId, range: target },
  );
  if (!selected) throw new Error(`test selection driver could not select rows for ${sessionId}`);
  await waitForSelectionToContain(page, sessionId, expectedTexts);
  await expectSelectionOverlayAttachedEventually(page);
}

async function selectVisibleTerminalTextWithTestDriver(
  page: Page,
  sessionId: string,
  text: string,
): Promise<void> {
  const selected = await page.evaluate(
    ({ sid, target }) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const controller = window.__ccTestPtySelectionControllers?.get(sid);
      if (!term || !controller) return false;
      const buffer = term.buffer.active;
      for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
        const line = buffer.getLine(row)?.translateToString(true) ?? "";
        const column = line.indexOf(target);
        if (column < 0) continue;
        return controller.selectRange({
          anchorRow: row,
          focusRow: row,
          anchorColumn: column,
          focusColumn: Math.min(column + target.length - 1, term.cols - 1),
        });
      }
      return false;
    },
    { sid: sessionId, target: text },
  );
  if (!selected) {
    throw new Error(`test selection driver could not select ${JSON.stringify(text)}`);
  }
  await waitForSelectionToContain(page, sessionId, [text]);
  await expectSelectionOverlayAttachedEventually(page);
}

async function installClipboardProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.__mobilePtyCopiedText = text;
        },
      },
    });
    document.execCommand = (command: string) => {
      throw new Error(`legacy copy should not run: ${command}`);
    };
  });
}

async function installInsecureContextClipboardProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    document.execCommand = (command: string) => {
      if (command !== "copy") return false;
      const source = document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]');
      if (!source) return false;
      window.__mobilePtyCopiedText = source.value;
      return true;
    };
  });
}

async function waitForSoftKeyboard(page: Page): Promise<boolean> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(
              document
                .querySelector("[data-keyboard-offset]")
                ?.getAttribute("data-keyboard-offset") ?? "0",
            ),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    return true;
  } catch {
    return false;
  }
}

test.describe("L4 mobile / PTY long press copy", () => {
  test.setTimeout(60_000);

  test("selected multi-line terminal range copies through the toolbar", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("PTY SMOKE READY");
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 90 },
          (_, i) => `COPY MOBILE LINE ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("COPY MOBILE LINE 089");

    const box = await emuPage.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
    if (!box) throw new Error("xterm screen missing");
    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const buffer = term.buffer.active;
      const startRow = buffer.viewportY + Math.min(8, Math.max(1, term.rows - 10));
      const endRow = startRow + 2;
      const startText = buffer.getLine(startRow)?.translateToString(true) ?? "";
      const endText = buffer.getLine(endRow)?.translateToString(true) ?? "";
      if (!startText.includes("COPY MOBILE LINE") || !endText.includes("COPY MOBILE LINE"))
        return null;
      return {
        startRowInViewport: startRow - buffer.viewportY,
        endRowInViewport: endRow - buffer.viewportY,
        cellWidth: screen.clientWidth / term.cols,
        cellHeight: screen.clientHeight / term.rows,
        startText,
        endText,
      };
    }, SESSION_ID);
    if (!target) throw new Error("target terminal lines are not in the visible terminal viewport");

    await selectVisibleTerminalRowsWithTestDriver(emuPage, SESSION_ID, target, [
      target.startText,
      target.endText,
    ]);

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", SESSION_ID),
      )
      .toContain(target.startText);
    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", SESSION_ID),
      )
      .toContain(target.endText);
    const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
    await expect(copyButton).toBeVisible();
    await expect(emuPage.getByRole("button", { name: "调整选区起点" })).toBeVisible();
    await expect(emuPage.getByRole("button", { name: "调整选区终点" })).toBeVisible();

    await installInsecureContextClipboardProbe(emuPage);
    await copyButton.click();
    await expect
      .poll(() => emuPage.evaluate(() => window.__mobilePtyCopiedText ?? ""))
      .toContain(target.startText);
    await expect(emuPage.getByText("已复制", { exact: true })).toBeVisible();
    await expect(copyButton).toBeHidden();
  });

  test("plain long press expands a short token to a usable initial range", async ({ emuPage }) => {
    await setupPtyChat(emuPage, {
      sessionId: `${SESSION_ID}-initial-range`,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty("alpha beta gamma delta\r\n");
    });
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTest?.pty.serialize(sid) ?? "",
          `${SESSION_ID}-initial-range`,
        ),
      )
      .toContain("alpha beta gamma delta");

    const box = await emuPage.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
    if (!box) throw new Error("xterm screen missing");
    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const buffer = term.buffer.active;
      for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
        const text = buffer.getLine(row)?.translateToString(true) ?? "";
        const column = text.indexOf("beta");
        if (column >= 0) {
          return {
            rowInViewport: row - buffer.viewportY,
            column: column + 1,
            cellWidth: screen.clientWidth / term.cols,
            cellHeight: screen.clientHeight / term.rows,
          };
        }
      }
      return null;
    }, `${SESSION_ID}-initial-range`);
    if (!target) throw new Error("initial-range target is not visible");

    await longPress(emuPage, {
      x: box.x + (target.column + 0.5) * target.cellWidth,
      y: box.y + (target.rowInViewport + 0.5) * target.cellHeight,
    });

    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTest?.pty.getSelection(sid) ?? "",
          `${SESSION_ID}-initial-range`,
        ),
      )
      .toBe("alpha beta gamma");

    const handle = emuPage.getByRole("button", { name: "调整选区起点" });
    const dot = emuPage.locator('[data-slot="pty-selection-handle-dot"]').first();
    await expect(handle).toBeVisible();
    await expect(dot).toBeVisible();
    const handleBox = await handle.boundingBox();
    const dotBox = await dot.boundingBox();
    if (!handleBox || !dotBox) throw new Error("selection handle geometry missing");
    expect(handleBox.width).toBeGreaterThanOrEqual(40);
    expect(dotBox.width).toBeGreaterThanOrEqual(8);
    expect(dotBox.width).toBeLessThanOrEqual(13);
  });

  test("long press opens selection without focusing the PTY input", async ({ emuPage }) => {
    const sessionId = `${SESSION_ID}-longpress-no-focus`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty("focus guard alpha beta gamma\r\n");
    });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("focus guard alpha beta gamma");

    const input = emuPage.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await expect(input).not.toBeFocused();
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

    const box = await emuPage.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
    if (!box) throw new Error("xterm screen missing");
    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const buffer = term.buffer.active;
      for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
        const text = buffer.getLine(row)?.translateToString(true) ?? "";
        const column = text.indexOf("alpha");
        if (column >= 0) {
          return {
            rowInViewport: row - buffer.viewportY,
            column: column + 1,
            cellWidth: screen.clientWidth / term.cols,
            cellHeight: screen.clientHeight / term.rows,
          };
        }
      }
      return null;
    }, sessionId);
    if (!target) throw new Error("focus guard target is not visible");

    await longPress(emuPage, {
      x: box.x + (target.column + 0.5) * target.cellWidth,
      y: box.y + (target.rowInViewport + 0.5) * target.cellHeight,
    });

    await expect(emuPage.getByRole("button", { name: "复制终端选区" })).toBeVisible();
    await expect(input).not.toBeFocused();
    await expect
      .poll(() =>
        emuPage.evaluate(() => ({
          activeIsPtyInput: document.activeElement?.getAttribute("aria-label") === "Terminal input",
          keyboardOffset: Number(
            document
              .querySelector("[data-keyboard-offset]")
              ?.getAttribute("data-keyboard-offset") ?? "0",
          ),
        })),
      )
      .toEqual({ activeIsPtyInput: false, keyboardOffset: 0 });
  });

  test("long press on a file link selects the whole link and downloads from the toolbar", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-link-download`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty("artifact @./build/out.tar.gz ready\r\n");
    });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("./build/out.tar.gz");

    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const buffer = term.buffer.active;
      const rect = screen.getBoundingClientRect();
      const cellWidth = screen.clientWidth / term.cols;
      const cellHeight = screen.clientHeight / term.rows;
      for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
        const text = buffer.getLine(row)?.translateToString(true) ?? "";
        const pathColumn = text.indexOf("./build/out.tar.gz");
        if (pathColumn < 0) continue;
        return {
          x: rect.left + (pathColumn + 4) * cellWidth,
          y: rect.top + (row - buffer.viewportY + 0.5) * cellHeight,
        };
      }
      return null;
    }, sessionId);
    if (!target) throw new Error("file link target is not visible");

    await longPress(emuPage, target);

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", sessionId),
      )
      .toBe("@./build/out.tar.gz");
    await expect(emuPage.getByRole("button", { name: "复制终端选区" })).toBeVisible();
    const downloadButton = emuPage.getByRole("button", { name: "下载终端选区文件" });
    await expect(downloadButton).toBeVisible();

    await downloadButton.click();
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__ptySmoke?.sent ?? []).some((raw) => {
            try {
              const message = JSON.parse(raw) as {
                type?: string;
                path?: string;
                disposition?: string;
              };
              return (
                message.type === "remote_file_url_request" &&
                message.path === "./build/out.tar.gz" &&
                message.disposition === "download"
              );
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);
    await expect(downloadButton).toBeHidden();
  });

  test("selected image path previews from the toolbar even when surrounding text is noisy", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-selected-image-preview`;
    await setupPtyChat(emuPage, { sessionId, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty("artifact a=b.jpg ready\r\n");
    });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("a=b.jpg");

    await selectVisibleTerminalTextWithTestDriver(emuPage, sessionId, "b.jpg");

    await expect(emuPage.getByRole("button", { name: "复制终端选区" })).toBeVisible();
    const previewButton = emuPage.getByRole("button", { name: "预览终端选区图片" });
    await expect(previewButton).toBeVisible();

    await previewButton.click();
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__ptySmoke?.sent ?? []).some((raw) => {
            try {
              const message = JSON.parse(raw) as {
                type?: string;
                path?: string;
                disposition?: string;
              };
              return (
                message.type === "remote_file_url_request" &&
                message.path === "b.jpg" &&
                message.disposition === "inline"
              );
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);
    await expect(previewButton).toBeHidden();
  });

  test("keeps copy handles anchored when long press closes the soft keyboard", async ({
    emuPage,
  }) => {
    const sessionId = `${SESSION_ID}-keyboard-selection`;
    await setupPtyChat(emuPage, {
      sessionId,
      baseUrl: mobileBaseUrl,
    });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 90 },
          (_, i) => `KEYBOARD COPY LINE ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("KEYBOARD COPY LINE 089");

    const terminal = emuPage.locator('[data-slot="pty-terminal"]');
    const terminalBox = await terminal.boundingBox();
    if (!terminalBox) throw new Error("PTY terminal missing");
    await touchTap(emuPage, {
      x: terminalBox.x + terminalBox.width / 2,
      y: terminalBox.y + Math.min(terminalBox.height / 2, 160),
    });
    await expect(
      emuPage.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
    ).toBeFocused();
    if (!(await waitForSoftKeyboard(emuPage))) {
      test.skip(true, "Android emulator did not expose a soft-keyboard visualViewport resize");
    }

    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      const container = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
      if (!term || !screen || !container) return null;
      const buffer = term.buffer.active;
      const screenRect = screen.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const visualBottom = window.visualViewport?.height ?? window.innerHeight;
      const cellWidth = screen.clientWidth / term.cols;
      const cellHeight = screen.clientHeight / term.rows;
      const top = Math.max(containerRect.top + 24, screenRect.top);
      const bottom = Math.min(containerRect.bottom, visualBottom) - 64;
      for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
        const y = screenRect.top + (row - buffer.viewportY + 0.5) * cellHeight;
        const text = buffer.getLine(row)?.translateToString(true) ?? "";
        if (y >= top && y <= bottom && text.includes("KEYBOARD COPY LINE")) {
          return {
            x: screenRect.left + cellWidth * 2,
            y,
            text,
          };
        }
      }
      return null;
    }, sessionId);
    if (!target) throw new Error("keyboard long-press target is not visible");

    await longPress(emuPage, { x: target.x, y: target.y });

    const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
    const startHandle = emuPage.getByRole("button", { name: "调整选区起点" });
    const endHandle = emuPage.getByRole("button", { name: "调整选区终点" });
    await expect(copyButton).toBeVisible();
    await expect(startHandle).toBeVisible();
    await expect(endHandle).toBeVisible();

    await expectSelectionOverlayStable(emuPage);

    const keyboardOffsetAfterLongPress = await emuPage.evaluate(() =>
      Number(
        document.querySelector("[data-keyboard-offset]")?.getAttribute("data-keyboard-offset") ??
          "0",
      ),
    );
    if (keyboardOffsetAfterLongPress > 0) {
      await execFileAsync("adb", ["shell", "input", "keyevent", "BACK"]);
      await expect
        .poll(
          () =>
            emuPage.evaluate(() =>
              Number(
                document
                  .querySelector("[data-keyboard-offset]")
                  ?.getAttribute("data-keyboard-offset") ?? "0",
              ),
            ),
          { timeout: 10_000 },
        )
        .toBe(0);
      await expectSelectionOverlayStable(emuPage);
    }
  });

  test("tap outside clears the copy affordance after the selected range updates", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: `${SESSION_ID}-handles`, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 90 },
          (_, i) => `HANDLE COPY LINE ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTest?.pty.serialize(sid) ?? "",
          `${SESSION_ID}-handles`,
        ),
      )
      .toContain("HANDLE COPY LINE 089");

    const box = await emuPage.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
    if (!box) throw new Error("xterm screen missing");
    const target = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const buffer = term.buffer.active;
      const startRow = buffer.viewportY + Math.min(7, Math.max(1, term.rows - 12));
      const endRow = startRow + 1;
      const nextRow = endRow + 1;
      const startText = buffer.getLine(startRow)?.translateToString(true) ?? "";
      const endText = buffer.getLine(endRow)?.translateToString(true) ?? "";
      const nextText = buffer.getLine(nextRow)?.translateToString(true) ?? "";
      if (!startText.includes("HANDLE COPY LINE") || !nextText.includes("HANDLE COPY LINE"))
        return null;
      return {
        startRowInViewport: startRow - buffer.viewportY,
        endRowInViewport: endRow - buffer.viewportY,
        nextRowInViewport: nextRow - buffer.viewportY,
        cellWidth: screen.clientWidth / term.cols,
        cellHeight: screen.clientHeight / term.rows,
        startText,
        endText,
        nextText,
      };
    }, `${SESSION_ID}-handles`);
    if (!target) throw new Error("target terminal lines are not visible");

    await selectVisibleTerminalRowsWithTestDriver(emuPage, `${SESSION_ID}-handles`, target, [
      target.startText,
      target.endText,
    ]);
    const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
    const endHandle = emuPage.getByRole("button", { name: "调整选区终点" });
    await expect(copyButton).toBeVisible();
    await expect(endHandle).toBeVisible();

    await selectVisibleTerminalRowsWithTestDriver(
      emuPage,
      `${SESSION_ID}-handles`,
      {
        ...target,
        endRowInViewport: target.nextRowInViewport,
        endText: target.nextText,
      },
      [target.startText, target.nextText],
    );
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTest?.pty.getSelection(sid) ?? "",
          `${SESSION_ID}-handles`,
        ),
      )
      .toContain(target.nextText);

    const viewport = emuPage.viewportSize();
    await expectSelectionClearedByOutsideTap(emuPage, [
      { x: box.x + 24, y: box.y + 24 },
      { x: 12, y: Math.max(12, (viewport?.height ?? 720) - 12) },
    ]);
  });

  edgeAutoscrollDiagnosticTest(
    "selection handle drag to the bottom edge autoscrolls and still copies",
    async ({ emuPage }) => {
      await setupPtyChat(emuPage, {
        sessionId: `${SESSION_ID}-autoscroll`,
        baseUrl: mobileBaseUrl,
      });
      await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
      await emuPage.evaluate(() => {
        window.__ptySmoke.sendPty(
          Array.from(
            { length: 180 },
            (_, i) => `AUTO COPY LINE ${String(i).padStart(3, "0")}\r\n`,
          ).join(""),
        );
      });
      await expect
        .poll(() =>
          emuPage.evaluate(
            (sid) => window.__ccTest?.pty.serialize(sid) ?? "",
            `${SESSION_ID}-autoscroll`,
          ),
        )
        .toContain("AUTO COPY LINE 179");

      const terminal = emuPage.locator('[data-slot="pty-terminal"]');
      await terminal.evaluate((el) => {
        const node = el as HTMLElement;
        const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.max(0, maxScrollTop - 760);
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expect
        .poll(() =>
          terminal.evaluate((el) => {
            const node = el as HTMLElement;
            const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
            return maxScrollTop - node.scrollTop;
          }),
        )
        .toBeGreaterThan(300);

      const beforeScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
      const beforeBottomGap = await terminal.evaluate((el) => {
        const node = el as HTMLElement;
        return Math.max(0, node.scrollHeight - node.clientHeight) - node.scrollTop;
      });
      const box = await emuPage.locator('[data-slot="pty-host"] .xterm-screen').boundingBox();
      const containerBox = await terminal.boundingBox();
      if (!box || !containerBox) throw new Error("pty screen/container missing");
      const target = await emuPage.evaluate((sid) => {
        const term = window.__ccTestPtyTerminals?.get(sid);
        const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!term || !screen) return null;
        const buffer = term.buffer.active;
        const startRow = buffer.viewportY + Math.min(6, Math.max(1, term.rows - 12));
        const startText = buffer.getLine(startRow)?.translateToString(true) ?? "";
        if (!startText.includes("AUTO COPY LINE")) return null;
        return {
          startRowInViewport: startRow - buffer.viewportY,
          startText,
          cellWidth: screen.clientWidth / term.cols,
          cellHeight: screen.clientHeight / term.rows,
        };
      }, `${SESSION_ID}-autoscroll`);
      if (!target) throw new Error("autoscroll target line is not visible");

      await selectVisibleTerminalRowsWithTestDriver(
        emuPage,
        `${SESSION_ID}-autoscroll`,
        {
          ...target,
          endRowInViewport: target.startRowInViewport,
          endText: target.startText,
        },
        [target.startText],
      );

      const endHandle = emuPage.getByRole("button", { name: "调整选区终点" });
      await expect(endHandle).toBeVisible();
      const handleBox = await endHandle.boundingBox();
      if (!handleBox) throw new Error("selection end handle missing");
      await touchDrag(
        emuPage,
        { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 },
        {
          x: box.x + target.cellWidth * 18,
          y: containerBox.y + containerBox.height - 10,
        },
        { holdAfterMoveMs: 900 },
      );

      await expect
        .poll(() =>
          terminal.evaluate((el) => {
            const node = el as HTMLElement;
            return Math.max(0, node.scrollHeight - node.clientHeight) - node.scrollTop;
          }),
        )
        .toBeLessThan(beforeBottomGap - 8);
      await expect
        .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
        .toBeGreaterThan(beforeScrollTop + 8);
      const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
      await expect(copyButton).toBeVisible();
      await installClipboardProbe(emuPage);
      await copyButton.click();
      await expect
        .poll(() => emuPage.evaluate(() => window.__mobilePtyCopiedText ?? ""))
        .toContain(target.startText);
      await expect(copyButton).toBeHidden();
    },
  );
});
