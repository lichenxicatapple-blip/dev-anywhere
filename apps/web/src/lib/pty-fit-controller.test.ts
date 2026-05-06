import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtyFitController, computePtyFontSize } from "./pty-fit-controller";

function defineSize(el: HTMLElement, sizes: { clientHeight: number; clientWidth: number }): void {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
}

function createTerminal(fontSize = 14) {
  return {
    cols: 80,
    rows: 20,
    options: { fontSize },
    refresh: vi.fn(),
  } as unknown as Terminal & {
    options: { fontSize: number };
    refresh: ReturnType<typeof vi.fn>;
  };
}

describe("computePtyFontSize", () => {
  it("computes a clamped font size from container and terminal geometry", () => {
    expect(computePtyFontSize(960, 480, 80, 20)).toBe(16);
    expect(computePtyFontSize(120, 120, 80, 20)).toBe(8);
    expect(computePtyFontSize(0, 480, 80, 20)).toBeNull();
  });
});

describe("attachPtyFitController", () => {
  let resizeDisconnect: ReturnType<typeof vi.fn>;
  let raf: ReturnType<typeof vi.spyOn>;

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
  });

  afterEach(() => {
    raf.mockRestore();
  });

  it("sets autoscaled font size, refreshes xterm, and requests relayout", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    attachPtyFitController({ container, term, enabled: true, onRelayout });

    expect(term.options.fontSize).toBe(15);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it("subtracts terminal padding before computing autoscaled font size", () => {
    const container = document.createElement("div") as HTMLDivElement;
    container.style.padding = "12px 16px";
    defineSize(container, { clientWidth: 512, clientHeight: 360 });
    const term = createTerminal(14);

    attachPtyFitController({ container, term, enabled: true });

    expect(term.options.fontSize).toBe(10);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
  });

  it("resets to default font size when autoscale is disabled", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal(15);

    attachPtyFitController({ container, term, enabled: false, defaultFontSize: 14 });

    expect(term.options.fontSize).toBe(14);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
  });

  it("does not refresh when computed font size is unchanged", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal(15);
    const onRelayout = vi.fn();

    attachPtyFitController({ container, term, enabled: true, onRelayout });

    expect(term.refresh).not.toHaveBeenCalled();
    expect(onRelayout).not.toHaveBeenCalled();
  });

  it("disconnects resize observation", () => {
    const container = document.createElement("div") as HTMLDivElement;
    defineSize(container, { clientWidth: 720, clientHeight: 360 });
    const term = createTerminal();

    const controller = attachPtyFitController({ container, term, enabled: true });
    controller.dispose();

    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
  });
});
