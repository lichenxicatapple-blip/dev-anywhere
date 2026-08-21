import type { IDisposable, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { attachPtyHistoryProjection } from "./pty-history-projection";
import {
  attachPtyManagedSelectionOverlay,
  xtermSelectionToPtySelectionRange,
} from "./pty-managed-selection-overlay";

const disposable = (): IDisposable => ({ dispose: vi.fn() });

describe("PTY managed selection overlay geometry", () => {
  it("converts xterm end-exclusive selections into inclusive managed endpoints", () => {
    expect(
      xtermSelectionToPtySelectionRange({ start: { x: 2, y: 4 }, end: { x: 6, y: 4 } }, 8),
    ).toEqual({
      anchor: { row: 4, column: 2 },
      focus: { row: 4, column: 5 },
      columnMode: false,
    });
    expect(
      xtermSelectionToPtySelectionRange({ start: { x: 6, y: 4 }, end: { x: 0, y: 5 } }, 8),
    ).toEqual({
      anchor: { row: 4, column: 6 },
      focus: { row: 4, column: 7 },
      columnMode: false,
    });
    expect(
      xtermSelectionToPtySelectionRange({ start: { x: 6, y: 4 }, end: { x: 3, y: 5 } }, 8),
    ).toEqual({
      anchor: { row: 4, column: 6 },
      focus: { row: 5, column: 2 },
      columnMode: false,
    });
    expect(
      xtermSelectionToPtySelectionRange({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }, 8),
    ).toBeNull();
  });

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

  it("keeps selection paint attached to live backfill after row identity rebases", () => {
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
        kind: "live-backfill",
        startLine: 25,
        endLine: 27,
        rowHeight: 20,
        topOffset: -40,
      }),
    ).toBe(true);
    rowIdentityOffset = -3;
    const projection = screen.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    if (!projection) throw new Error("missing live backfill projection");
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

  it("uses one projected row plane when active viewportY is ahead of the painted frame", () => {
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
      top: 0,
      right: 80,
      bottom: 80,
      width: 80,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 60,
      right: 80,
      bottom: 140,
      width: 80,
      height: 80,
      x: 0,
      y: 60,
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
    const terminal = {
      cols: 8,
      rows: 4,
      element: terminalElement,
      options: { theme: { selectionBackground: "#123456" } },
      buffer: { active: { viewportY: 70 } },
      onScroll: () => disposable(),
      onRender: () => disposable(),
      onResize: () => disposable(),
    } as unknown as Terminal;
    const history = attachPtyHistoryProjection(terminalElement, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div>row20</div><div>row21</div><div>row22</div></div></pre></body></html>",
      getSelectionLine: () => line as never,
    });
    expect(
      history.render({
        kind: "live-backfill",
        startLine: 20,
        endLine: 22,
        rowHeight: 20,
        topOffset: -60,
      }),
    ).toBe(true);
    const projection = screen.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    if (!projection) throw new Error("missing live backfill projection");
    vi.spyOn(projection, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 80,
      bottom: 60,
      width: 80,
      height: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const overlay = attachPtyManagedSelectionOverlay({
      terminal,
      container,
      getLine: () => line as never,
    });
    overlay.render({
      anchor: { row: 20, column: 1 },
      focus: { row: 23, column: 2 },
      columnMode: true,
    });

    const segments = screen.querySelectorAll<HTMLElement>(
      '[data-slot="pty-managed-selection-segment"]',
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.dataset).toMatchObject({
      firstRow: "20",
      lastRow: "23",
      firstColumn: "1",
      columnCount: "2",
    });
    expect(segments[0]?.style.top).toBe("-60px");
    expect(segments[0]?.style.height).toBe("80px");

    overlay.dispose();
    history.dispose();
  });

  it("mirrors an xterm-owned active range only across projected rows", () => {
    const container = document.createElement("div");
    const terminalElement = document.createElement("div");
    const screen = document.createElement("div");
    const renderedRows = document.createElement("div");
    const nativeSelection = document.createElement("div");
    screen.className = "xterm-screen";
    renderedRows.className = "xterm-rows";
    nativeSelection.className = "xterm-selection";
    screen.append(renderedRows, nativeSelection);
    terminalElement.append(screen);
    document.body.append(container, terminalElement);

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 80,
      bottom: 80,
      width: 80,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 40,
      right: 80,
      bottom: 120,
      width: 80,
      height: 80,
      x: 0,
      y: 40,
      toJSON: () => ({}),
    });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 80 });

    const line = {
      length: 8,
      isWrapped: false,
      getCell: (column: number) => ({
        getWidth: () => (column === 3 ? 2 : column === 4 ? 0 : 1),
        getChars: () => "x",
      }),
      translateToString: () => "xxxxxxxx",
    };
    const terminal = {
      cols: 8,
      rows: 4,
      element: terminalElement,
      options: { theme: { selectionBackground: "#123456" } },
      buffer: { active: { viewportY: 12 } },
      onScroll: () => disposable(),
      onRender: () => disposable(),
      onResize: () => disposable(),
    } as unknown as Terminal;
    const history = attachPtyHistoryProjection(terminalElement, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div>row10</div><div>row11</div></div></pre></body></html>",
      getSelectionLine: () => line as never,
    });
    history.render({
      kind: "live-backfill",
      startLine: 10,
      endLine: 11,
      rowHeight: 20,
      topOffset: -40,
    });
    const projection = screen.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    if (!projection) throw new Error("missing live backfill projection");
    vi.spyOn(projection, "getBoundingClientRect").mockReturnValue({
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

    let nativeRange = xtermSelectionToPtySelectionRange(
      { start: { x: 1, y: 11 }, end: { x: 3, y: 12 } },
      8,
    );
    const overlay = attachPtyManagedSelectionOverlay({
      terminal,
      container,
      getLine: () => line as never,
      resolveRange: () => nativeRange,
      projectionOnly: true,
      overlaySlot: "pty-search-selection-overlay",
      segmentSlot: "pty-search-selection-segment",
      selectionBackground: "#7a4e00",
      borderColor: "#f5f543",
      opacity: "0.62",
    });
    overlay.render(nativeRange);

    const segments = screen.querySelectorAll<HTMLElement>(
      '[data-slot="pty-search-selection-segment"]',
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.dataset).toMatchObject({
      firstRow: "11",
      lastRow: "11",
      firstColumn: "1",
      columnCount: "7",
    });
    expect(segments[0]?.style.backgroundColor).toBe("rgb(122, 78, 0)");
    expect(segments[0]?.style.opacity).toBe("0.62");
    expect(segments[0]?.style.boxShadow).toContain("#f5f543");

    nativeRange = {
      anchor: { row: 12, column: 1 },
      focus: { row: 12, column: 2 },
      columnMode: false,
    };
    overlay.render(nativeRange);
    expect(screen.querySelector('[data-slot="pty-search-selection-overlay"]')).toBeNull();

    nativeRange = null;
    overlay.render({
      anchor: { row: 11, column: 1 },
      focus: { row: 11, column: 2 },
      columnMode: false,
    });
    expect(screen.querySelector('[data-slot="pty-search-selection-overlay"]')).toBeNull();

    nativeRange = {
      anchor: { row: 11, column: 1 },
      focus: { row: 11, column: 2 },
      columnMode: false,
    };
    history.dispose();
    overlay.render(nativeRange);
    expect(screen.querySelector('[data-slot="pty-search-selection-overlay"]')).toBeNull();

    overlay.dispose();
  });
});
