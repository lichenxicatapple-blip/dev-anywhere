import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPtyFontSize, computePtyFontSize, fitPtyFontSizeOnce } from "./pty-fit-controller";

function defineSize(el: HTMLElement, sizes: { clientHeight: number; clientWidth: number }): void {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
}

function createTerminal(fontSize = 14) {
  return {
    cols: 80,
    rows: 20,
    options: { fontSize },
    resize: vi.fn(),
    refresh: vi.fn(),
  } as unknown as Terminal & {
    options: { fontSize: number };
    resize: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
}

describe("computePtyFontSize", () => {
  it("computes a clamped font size from container width and terminal columns", () => {
    expect(computePtyFontSize(960, 480, 80, 20)).toBe(16);
    expect(computePtyFontSize(120, 120, 80, 20)).toBe(8);
    expect(computePtyFontSize(0, 480, 80, 20)).toBeNull();
  });

  it("does not shrink font size to fit all terminal rows", () => {
    expect(computePtyFontSize(960, 120, 80, 200)).toBe(16);
  });
});

describe("pty font size helpers", () => {
  let raf: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
  });

  afterEach(() => {
    raf.mockRestore();
  });

  it("applies a manual font size, refreshes xterm, and requests relayout", () => {
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    expect(applyPtyFontSize(term, 16, onRelayout)).toBe(true);

    expect(term.options.fontSize).toBe(16);
    expect(term.resize).toHaveBeenCalledWith(80, 20);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when manual font size is unchanged", () => {
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    expect(applyPtyFontSize(term, 14, onRelayout)).toBe(false);

    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
    expect(onRelayout).not.toHaveBeenCalled();
  });

  it("fits font size once from current terminal geometry", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    const next = fitPtyFontSizeOnce({ container, term, onRelayout });

    expect(next).toBe(15);
    expect(term.options.fontSize).toBe(15);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it("subtracts terminal padding before fitting font size", () => {
    const container = document.createElement("div") as HTMLDivElement;
    container.style.padding = "12px 16px";
    defineSize(container, { clientWidth: 512, clientHeight: 360 });
    const term = createTerminal(14);

    const next = fitPtyFontSizeOnce({ container, term });

    expect(next).toBe(10);
    expect(term.options.fontSize).toBe(10);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
  });

  it("does not refresh when fitted font size is unchanged", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal(15);
    const onRelayout = vi.fn();

    const next = fitPtyFontSizeOnce({ container, term, onRelayout });

    expect(next).toBe(15);
    expect(term.refresh).not.toHaveBeenCalled();
    expect(onRelayout).not.toHaveBeenCalled();
  });

  it("returns null when current geometry is not measurable", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 0, clientHeight: 360 });
    const term = createTerminal();

    const next = fitPtyFontSizeOnce({ container, term });

    expect(next).toBeNull();
    expect(term.refresh).not.toHaveBeenCalled();
  });
});
