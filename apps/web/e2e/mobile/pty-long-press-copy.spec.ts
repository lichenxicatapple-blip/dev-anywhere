// 真 Android Chrome: PTY 是 xterm canvas/WebGL, 不能依赖浏览器原生 DOM 文本选择。
// 移动端长按应走 DEV Anywhere 自己的 xterm buffer 选区, 支持拖拽范围和边缘自动滚动。
import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-pty-long-press-copy";

declare global {
  interface Window {
    __mobilePtyLongPressEvents?: Array<{ type: string; target: string }>;
    __mobilePtySelectCalls?: Array<{ column: number; row: number; length: number; line: string }>;
    __mobilePtyCopiedText?: string;
  }
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
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: end.x, y: end.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
      });
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
        Array.from({ length: 90 }, (_, i) => `COPY MOBILE LINE ${String(i).padStart(3, "0")}\r\n`).join(""),
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
      if (!startText.includes("COPY MOBILE LINE") || !endText.includes("COPY MOBILE LINE")) return null;
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
          target: event.target instanceof Element ? event.target.className || event.target.tagName : "",
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
      .poll(() => emuPage.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", SESSION_ID))
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
    await setupPtyChat(emuPage, { sessionId: `${SESSION_ID}-initial-range`, baseUrl: mobileBaseUrl });
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

  test("tap outside clears the copy affordance and dragging handles adjusts the selection", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: `${SESSION_ID}-handles`, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 90 }, (_, i) => `HANDLE COPY LINE ${String(i).padStart(3, "0")}\r\n`).join(""),
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
      if (!startText.includes("HANDLE COPY LINE") || !nextText.includes("HANDLE COPY LINE")) return null;
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
        Array.from({ length: 180 }, (_, i) => `AUTO COPY LINE ${String(i).padStart(3, "0")}\r\n`).join(""),
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
