import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { activateXtermLinkAtPoint } from "./xterm-touch-link-activation";

function defineSize(el: HTMLElement, sizes: { width: number; height: number }): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.height });
}

function createTerminal() {
  const host = document.createElement("div");
  const xterm = document.createElement("div");
  const screen = document.createElement("div");
  xterm.className = "xterm";
  screen.className = "xterm-screen";
  xterm.append(screen);
  host.append(xterm);
  defineSize(screen, { width: 800, height: 400 });
  screen.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      right: 810,
      bottom: 420,
      width: 800,
      height: 400,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect;

  const terminal = {
    cols: 80,
    rows: 20,
    element: xterm,
    buffer: {
      active: {
        viewportY: 100,
      },
    },
  } as unknown as Terminal;

  return { terminal };
}

describe("activateXtermLinkAtPoint", () => {
  it("activates the provider link under a touch point", () => {
    const { terminal } = createTerminal();
    const activate = vi.fn();
    const provider: ILinkProvider = {
      provideLinks: (line, callback) => {
        expect(line).toBe(105);
        callback([
          {
            text: "./docs/result.md",
            range: { start: { x: 7, y: 105 }, end: { x: 24, y: 105 } },
            activate,
          },
        ]);
      },
    };

    const handled = activateXtermLinkAtPoint(terminal, [provider], {
      clientX: 10 + 10 * 6.5,
      clientY: 20 + 20 * 4.5,
    });

    expect(handled).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    const [event, text] = activate.mock.calls[0] ?? [];
    expect(text).toBe("./docs/result.md");
    expect((event as MouseEvent & { pointerType?: string }).pointerType).toBe("touch");
  });

  it("does not activate links outside the tapped cell", () => {
    const { terminal } = createTerminal();
    const activate = vi.fn();
    const provider: ILinkProvider = {
      provideLinks: (_line, callback) => {
        callback([
          {
            text: "./docs/result.md",
            range: { start: { x: 40, y: 105 }, end: { x: 50, y: 105 } },
            activate,
          },
        ]);
      },
    };

    expect(
      activateXtermLinkAtPoint(terminal, [provider], {
        clientX: 10 + 10 * 6.5,
        clientY: 20 + 20 * 4.5,
      }),
    ).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
});
