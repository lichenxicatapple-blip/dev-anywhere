import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPtyFontSize } from "./pty-font-size-controller";

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

describe("pty font size controller", () => {
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

  it("does not refresh when the manual font size is unchanged", () => {
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    expect(applyPtyFontSize(term, 14, onRelayout)).toBe(false);

    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
    expect(onRelayout).not.toHaveBeenCalled();
  });
});
