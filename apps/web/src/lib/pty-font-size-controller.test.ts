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

  it("applies a manual font size and requests relayout without forcing a refresh or resize", () => {
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    expect(applyPtyFontSize(term, 16, onRelayout)).toBe(true);

    expect(term.options.fontSize).toBe(16);
    // xterm 自身在 fontSize 变化后会触发 render；显式 refresh 在 WebGL renderer 下
    // 触发 atlas 全量重建，term.resize 在 cols/rows 不变时早返回是死代码——都不该调。
    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it("does not touch the terminal when the manual font size is unchanged", () => {
    const term = createTerminal(14);
    const onRelayout = vi.fn();

    expect(applyPtyFontSize(term, 14, onRelayout)).toBe(false);

    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
    expect(onRelayout).not.toHaveBeenCalled();
  });
});
