import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtyResizeController, computePtyGeometry } from "./pty-resize-controller";

function defineSize(el: HTMLElement, sizes: { clientHeight: number; clientWidth: number }): void {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
}

function createTerminal() {
  const root = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  root.append(screen);
  defineSize(screen, { clientWidth: 800, clientHeight: 400 });

  return {
    cols: 80,
    rows: 20,
    element: root,
    resize: vi.fn(function resize(
      this: { cols: number; rows: number },
      cols: number,
      rows: number,
    ) {
      this.cols = cols;
      this.rows = rows;
    }),
  } as unknown as Terminal & { resize: ReturnType<typeof vi.fn> };
}

describe("computePtyGeometry", () => {
  it("computes terminal cols and rows from container and cell size", () => {
    expect(computePtyGeometry(1200, 600, 10, 20)).toEqual({ cols: 120, rows: 30 });
  });

  it("rounds up rows when the viewport would otherwise leave nearly a full blank row", () => {
    expect(computePtyGeometry(336, 618, 8, 20)).toEqual({ cols: 42, rows: 31 });
  });

  it("keeps rows floored when the leftover space is small", () => {
    expect(computePtyGeometry(336, 612, 8, 20)).toEqual({ cols: 42, rows: 30 });
  });

  it("returns null when dimensions are not measurable", () => {
    expect(computePtyGeometry(1200, 600, 0, 20)).toBeNull();
  });
});

describe("attachPtyResizeController", () => {
  let resizeDisconnect: ReturnType<typeof vi.fn>;
  let raf: ReturnType<typeof vi.spyOn>;
  let caf: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resizeDisconnect = vi.fn();
    globalThis.ResizeObserver = class {
      observe = vi.fn();
      disconnect = resizeDisconnect;
    } as unknown as typeof ResizeObserver;
    raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    caf = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    raf.mockRestore();
    caf.mockRestore();
  });

  it("resizes xterm and notifies proxy when container has more space", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 1200, clientHeight: 600 });
    const term = createTerminal();
    const onResize = vi.fn();
    const onRelayout = vi.fn();

    attachPtyResizeController({ container, term, onResize, onRelayout });

    expect(term.resize).toHaveBeenCalledWith(120, 30);
    expect(onResize).toHaveBeenCalledWith(120, 30);
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it("does not resize when geometry is unchanged", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 800, clientHeight: 400 });
    const term = createTerminal();
    const onResize = vi.fn();

    attachPtyResizeController({ container, term, onResize });

    expect(term.resize).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("preserves current rows while allowing column changes when requested", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 1000, clientHeight: 220 });
    const term = createTerminal();
    const onResize = vi.fn();

    attachPtyResizeController({
      container,
      term,
      onResize,
      preserveRows: () => true,
    });

    expect(term.resize).toHaveBeenCalledWith(100, 20);
    expect(onResize).toHaveBeenCalledWith(100, 20);
  });

  it("does not resize to a shorter soft-keyboard height when rows are preserved", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 800, clientHeight: 220 });
    const term = createTerminal();
    const onResize = vi.fn();

    attachPtyResizeController({
      container,
      term,
      onResize,
      preserveRows: () => true,
    });

    expect(term.resize).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("disconnects resize observation", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 1200, clientHeight: 600 });
    const term = createTerminal();

    const controller = attachPtyResizeController({ container, term, onResize: vi.fn() });
    controller.dispose();

    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
  });
});
