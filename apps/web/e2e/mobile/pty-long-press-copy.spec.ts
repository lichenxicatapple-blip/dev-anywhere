// 真 Android Chrome: PTY 是 xterm canvas/WebGL, 不能依赖浏览器原生 DOM 文本选择。
// 移动端长按应走 DEV Anywhere 自己的 xterm buffer 选区, 支持拖拽范围和边缘自动滚动。
import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-pty-long-press-copy";
const execFileAsync = promisify(execFile);

declare global {
  interface Window {
    __mobilePtyLongPressEvents?: Array<{ type: string; target: string }>;
    __mobilePtySelectCalls?: Array<{ column: number; row: number; length: number; line: string }>;
    __mobilePtyCopiedText?: string;
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
  options: { holdAfterMoveMs?: number } = {},
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await page.waitForTimeout(950);
    if (end.x !== start.x || end.y !== start.y) {
      const steps = 8;
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
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
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(options.holdAfterMoveMs ?? 100);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
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
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
    });
    await page.waitForTimeout(80);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: end.x, y: end.y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
    });
    await page.waitForTimeout(120);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
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

  test("long press drag selects a multi-line terminal range and copies through native clipboard", async ({
    emuPage,
  }) => {
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

    await emuPage.evaluate(() => {
      window.__mobilePtyLongPressEvents = [];
      window.__mobilePtySelectCalls = [];
      const record = (event: Event) => {
        window.__mobilePtyLongPressEvents?.push({
          type: event.type,
          target:
            event.target instanceof Element ? event.target.className || event.target.tagName : "",
        });
      };
      for (const type of [
        "pointerdown",
        "pointerup",
        "pointercancel",
        "touchstart",
        "touchend",
        "touchcancel",
        "contextmenu",
      ]) {
        document.addEventListener(type, record, { capture: true, once: false });
      }
    });
    await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      if (!term) return;
      const originalSelect = term.select.bind(term);
      term.select = (column: number, row: number, length: number) => {
        window.__mobilePtySelectCalls?.push({
          column,
          row,
          length,
          line: term.buffer.active.getLine(row)?.translateToString(true) ?? "",
        });
        originalSelect(column, row, length);
      };
    }, SESSION_ID);

    await longPress(
      emuPage,
      {
        x: box.x + target.cellWidth * 0.5,
        y: box.y + (target.startRowInViewport + 0.5) * target.cellHeight,
      },
      {
        x: box.x + target.cellWidth * (target.endText.length + 2),
        y: box.y + (target.endRowInViewport + 0.5) * target.cellHeight,
      },
    );

    await expect
      .poll(
        () => emuPage.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", SESSION_ID),
        {
          message: await emuPage.evaluate(() =>
            JSON.stringify({
              events: window.__mobilePtyLongPressEvents ?? [],
              selects: window.__mobilePtySelectCalls ?? [],
            }),
          ),
        },
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

    await installClipboardProbe(emuPage);
    await copyButton.click();
    await expect
      .poll(() => emuPage.evaluate(() => window.__mobilePtyCopiedText ?? ""))
      .toContain(target.startText);
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
    const downloadButton = emuPage.getByRole("button", { name: "下载终端链接" });
    await expect(downloadButton).toBeVisible();

    await downloadButton.click();
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__ptySmoke?.sent ?? []).some((raw) => {
            try {
              const message = JSON.parse(raw) as { type?: string; path?: string };
              return (
                message.type === "file_download_request" && message.path === "./build/out.tar.gz"
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

  test("tap outside clears the copy affordance and dragging handles adjusts the selection", async ({
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

    await longPress(
      emuPage,
      {
        x: box.x + target.cellWidth * 0.5,
        y: box.y + (target.startRowInViewport + 0.5) * target.cellHeight,
      },
      {
        x: box.x + target.cellWidth * (target.endText.length + 2),
        y: box.y + (target.endRowInViewport + 0.5) * target.cellHeight,
      },
    );
    const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
    const endHandle = emuPage.getByRole("button", { name: "调整选区终点" });
    await expect(copyButton).toBeVisible();
    await expect(endHandle).toBeVisible();

    const handleBox = await endHandle.boundingBox();
    if (!handleBox) throw new Error("end handle missing");
    await touchDrag(
      emuPage,
      { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 },
      {
        x: box.x + target.cellWidth * (target.nextText.length + 2),
        y: box.y + (target.nextRowInViewport + 0.5) * target.cellHeight,
      },
    );
    await expect
      .poll(() =>
        emuPage.evaluate(
          (sid) => window.__ccTest?.pty.getSelection(sid) ?? "",
          `${SESSION_ID}-handles`,
        ),
      )
      .toContain(target.nextText);

    await touchTap(emuPage, { x: box.x + 24, y: box.y + 24 });
    await expect(copyButton).toBeHidden();
    await expect(endHandle).toBeHidden();
  });

  test("dragging a long-press selection to the bottom edge autoscrolls and still copies", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: `${SESSION_ID}-autoscroll`, baseUrl: mobileBaseUrl });
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
      node.scrollTop = Math.max(0, node.scrollTop - 760);
    });
    await emuPage.waitForTimeout(250);

    const beforeScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
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

    await longPress(
      emuPage,
      {
        x: box.x + target.cellWidth * 0.5,
        y: box.y + (target.startRowInViewport + 0.5) * target.cellHeight,
      },
      {
        x: box.x + target.cellWidth * 18,
        y: containerBox.y + containerBox.height - 40,
      },
      { holdAfterMoveMs: 900 },
    );

    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeGreaterThan(beforeScrollTop);
    const copyButton = emuPage.getByRole("button", { name: "复制终端选区" });
    await expect(copyButton).toBeVisible();
    await installClipboardProbe(emuPage);
    await copyButton.click();
    await expect
      .poll(() => emuPage.evaluate(() => window.__mobilePtyCopiedText ?? ""))
      .toContain(target.startText);
    await expect(copyButton).toBeHidden();
  });
});
