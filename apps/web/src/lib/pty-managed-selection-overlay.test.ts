import type { IDisposable, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { attachPtyHistoryProjection } from "./pty-history-projection";
import { attachPtyManagedSelectionOverlay } from "./pty-managed-selection-overlay";

const disposable = (): IDisposable => ({ dispose: vi.fn() });

describe("PTY managed selection overlay geometry", () => {
  it("paints only visible rows for a large column range while retaining absolute endpoints", () => {
    const container = document.createElement("div");
    const terminalElement = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    terminalElement.append(screen);
    document.body.append(container, terminalElement);

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 80,
      bottom: 40,
      width: 80,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 80,
      bottom: 40,
      width: 80,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 40 });

    const terminal = {
      cols: 8,
      rows: 4,
      element: terminalElement,
      options: { theme: { selectionBackground: "#123456" } },
      buffer: { active: { viewportY: 10 } },
      onScroll: () => disposable(),
      onRender: () => disposable(),
      onResize: () => disposable(),
    } as unknown as Terminal;
    const getLine = vi.fn(() => null);
    const overlay = attachPtyManagedSelectionOverlay({ terminal, container, getLine });

    overlay.render({
      anchor: { row: 0, column: 1 },
      focus: { row: 4_999, column: 2 },
      columnMode: true,
    });

    const root = screen.querySelector<HTMLElement>('[data-slot="pty-managed-selection-overlay"]');
    const segment = root?.querySelector<HTMLElement>('[data-slot="pty-managed-selection-segment"]');
    expect(root?.dataset).toMatchObject({
      anchorRow: "0",
      anchorColumn: "1",
      focusRow: "4999",
      focusColumn: "2",
    });
    expect(segment?.dataset).toMatchObject({
      firstRow: "10",
      lastRow: "13",
      firstColumn: "1",
      columnCount: "2",
    });
    expect(segment?.style.backgroundColor).toBe("rgb(18, 52, 86)");
    expect(getLine.mock.calls.length).toBeLessThan(10);

    overlay.dispose();
    expect(screen.querySelector('[data-slot="pty-managed-selection-overlay"]')).toBeNull();
  });

  it("keeps selection paint attached to a frozen projection after row identity rebases", () => {
    const container = document.createElement("div");
    const terminalElement = document.createElement("div");
    const screen = document.createElement("div");
    const renderedRows = document.createElement("div");
    const renderedRow = document.createElement("div");
    const nativeSelection = document.createElement("div");
    screen.className = "xterm-screen";
    renderedRows.className = "xterm-rows";
    nativeSelection.className = "xterm-selection";
    renderedRows.append(renderedRow);
    screen.append(renderedRows, nativeSelection);
    terminalElement.append(screen);
    document.body.append(container, terminalElement);

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: -10,
      right: 80,
      bottom: 70,
      width: 80,
      height: 80,
      x: 0,
      y: -10,
      toJSON: () => ({}),
    });
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 20,
      right: 80,
      bottom: 100,
      width: 80,
      height: 80,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 80 });

    const cell = { getWidth: () => 1, getChars: () => "x" };
    const line = {
      length: 8,
      isWrapped: false,
      getCell: () => cell,
      translateToString: () => "xxxxxxxx",
    };
    let rowIdentityOffset = 0;
    const terminal = {
      cols: 8,
      rows: 4,
      element: terminalElement,
      options: { theme: { selectionBackground: "#123456" } },
      buffer: { active: { viewportY: 30 } },
      onScroll: () => disposable(),
      onRender: () => disposable(),
      onResize: () => disposable(),
    } as unknown as Terminal;
    const history = attachPtyHistoryProjection(terminalElement, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div>row25</div><div>row26</div><div>row27</div></div></pre></body></html>",
      getSelectionLine: () => line as never,
      getBufferRowIdentityOffset: () => rowIdentityOffset,
    });
    expect(
      history.render({
        kind: "review",
        startLine: 25,
        endLine: 27,
        rowHeight: 20,
        topOffset: -40,
      }),
    ).toBe(true);
    rowIdentityOffset = -3;
    const projection = screen.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    if (!projection) throw new Error("missing review projection");
    vi.spyOn(projection, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: -20,
      right: 80,
      bottom: 40,
      width: 80,
      height: 60,
      x: 0,
      y: -20,
      toJSON: () => ({}),
    });

    const overlay = attachPtyManagedSelectionOverlay({
      terminal,
      container,
      getLine: () => line as never,
    });
    overlay.render({
      anchor: { row: 23, column: 1 },
      focus: { row: 23, column: 2 },
    });

    const segment = screen.querySelector<HTMLElement>(
      '[data-slot="pty-managed-selection-segment"]',
    );
    expect(segment?.dataset).toMatchObject({ firstRow: "23", lastRow: "23" });
    expect(segment?.style.top).toBe("-20px");
    expect(segment?.style.height).toBe("20px");

    overlay.dispose();
    history.dispose();
  });
});
