import { describe, expect, it, vi } from "vitest";
import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import {
  getClientPositionForTerminalPoint,
  getTerminalPointAtClient,
  selectTerminalLineAtPoint,
  selectTerminalInitialRangeAtPoint,
  selectTerminalRange,
  selectTerminalTokenAtPoint,
} from "./pty-line-selection";

function cell(chars: string): IBufferCell {
  return {
    getChars: () => chars,
    getWidth: () => (chars ? 1 : 1),
  } as unknown as IBufferCell;
}

function line(cells: string[]): IBufferLine {
  return {
    length: cells.length,
    getCell: (index: number) => cell(cells[index] ?? ""),
    translateToString: (_trimRight?: boolean, start = 0, end = cells.length) =>
      cells.slice(start, end).join("").replace(/\s+$/, ""),
  } as unknown as IBufferLine;
}

describe("selectTerminalLineAtPoint", () => {
  it("selects the visible buffer line under the touch point and returns copied text", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32 ? line([" ", " ", "a", "b", "c", " ", " "]) : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });

    const selected = selectTerminalLineAtPoint({
      terminal,
      host,
      clientX: 30,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected?.text).toBe("abc");
    expect(select).toHaveBeenCalledWith(2, 32, 3);
  });
});

describe("selectTerminalTokenAtPoint", () => {
  it("selects only the contiguous token under the touch point", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 24,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32
              ? line([" ", " ", "p", "n", "p", "m", " ", "d", "e", "v", ":", "r", "e", "s", "t", "a", "r", "t"])
              : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 240, height: 200 } as DOMRect);
    Object.defineProperties(screen, {
      clientWidth: { value: 240 },
      clientHeight: { value: 200 },
    });

    const selected = selectTerminalTokenAtPoint({
      terminal,
      host,
      clientX: 99,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected?.text).toBe("dev:restart");
    expect(select).toHaveBeenCalledWith(7, 32, 11);
  });

  it("does not select the whole row when the touch lands on whitespace", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32 ? line([" ", " ", "a", "b", "c", " ", "d", "e", "f"]) : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });

    const selected = selectTerminalTokenAtPoint({
      terminal,
      host,
      clientX: 60,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
});

describe("selectTerminalInitialRangeAtPoint", () => {
  it("expands a short touched token to nearby tokens so the handles are usable", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 40,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32
              ? line(
                  "pnpm dev:restart --filter web"
                    .split("")
                    .concat(Array.from({ length: 12 }, () => " ")),
                )
              : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 200 } as DOMRect);

    const selected = selectTerminalInitialRangeAtPoint({
      terminal,
      host,
      clientX: 92,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected?.text).toBe("pnpm dev:restart --filter");
    expect(select).toHaveBeenCalledWith(0, 32, 25);
  });

  it("keeps a long touched token tight instead of selecting the whole row", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 40,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32
              ? line("run very-long-token-here now".split("").concat(Array.from({ length: 12 }, () => " ")))
              : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 200 } as DOMRect);

    const selected = selectTerminalInitialRangeAtPoint({
      terminal,
      host,
      clientX: 82,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected?.text).toBe("very-long-token-here");
    expect(select).toHaveBeenCalledWith(4, 32, 20);
  });

  it("uses the nearest token when the long press lands on nearby whitespace", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 30,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) =>
            row === 32
              ? line("alpha  beta gamma".split("").concat(Array.from({ length: 12 }, () => " ")))
              : undefined,
        },
      },
      select,
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 300, height: 200 } as DOMRect);

    const selected = selectTerminalInitialRangeAtPoint({
      terminal,
      host,
      clientX: 70,
      clientY: 60,
      cellWidth: 10,
      cellHeight: 20,
    });

    expect(selected?.text).toBe("alpha  beta gamma");
    expect(select).toHaveBeenCalledWith(0, 32, 17);
  });
});

describe("selectTerminalRange", () => {
  it("selects an arbitrary multi-line range and returns copied text", () => {
    const select = vi.fn();
    const terminal = {
      rows: 10,
      cols: 8,
      buffer: {
        active: {
          viewportY: 30,
          getLine: (row: number) => {
            if (row === 32) return line(["a", "b", "c", "d", "e"]);
            if (row === 33) return line(["f", "g", "h", "i", "j"]);
            return undefined;
          },
        },
      },
      select,
    } as unknown as Terminal;

    const selected = selectTerminalRange({
      terminal,
      anchor: { row: 32, column: 1 },
      focus: { row: 33, column: 2 },
    });

    expect(selected?.text).toBe("bcde\nfgh");
    expect(select).toHaveBeenCalledWith(1, 32, 10);
  });
});

describe("getTerminalPointAtClient", () => {
  it("maps client coordinates into buffer row and column", () => {
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: { active: { viewportY: 30 } },
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });

    expect(
      getTerminalPointAtClient({
        terminal,
        host,
        clientX: 35,
        clientY: 65,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ row: 32, column: 2 });
  });
});

describe("getClientPositionForTerminalPoint", () => {
  it("projects a visible buffer point back to a client-space selection handle position", () => {
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: { active: { viewportY: 30 } },
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });

    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 32, column: 2 },
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 30, top: 80 });
    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 32, column: 2 },
        affinity: "after",
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 40, top: 80 });
  });

  it("returns null when the buffer point is outside the visible viewport", () => {
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: { active: { viewportY: 30 } },
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 } as DOMRect);

    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 50, column: 2 },
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toBeNull();
  });
});
