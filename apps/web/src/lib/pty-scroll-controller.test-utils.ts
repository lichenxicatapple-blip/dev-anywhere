import type { Terminal } from "@xterm/xterm";
import { vi } from "vitest";

type Handler = () => void;

export function defineSize(
  el: HTMLElement,
  sizes: { clientHeight?: number; clientWidth?: number },
): void {
  if (sizes.clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  }
  if (sizes.clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
  }
}

export function defineScrollHeight(el: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
}

export function defineScrollWidth(el: HTMLElement, scrollWidth: number): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
}

export function createPtyScrollDom() {
  const container = document.createElement("div") as HTMLDivElement;
  const spacer = document.createElement("div") as HTMLDivElement;
  const host = document.createElement("div") as HTMLDivElement;
  const xterm = document.createElement("div");
  const screen = document.createElement("div");
  xterm.className = "xterm";
  screen.className = "xterm-screen";
  host.append(xterm, screen);
  defineSize(container, { clientHeight: 400, clientWidth: 800 });
  defineScrollHeight(container, 2000);
  defineScrollWidth(container, 800);
  defineSize(screen, { clientHeight: 400, clientWidth: 800 });
  return { container, spacer, host, xterm };
}

export function markUserVerticalScrollIntent(container: HTMLElement): void {
  container.dispatchEvent(touchEvent("touchstart", 300));
  container.dispatchEvent(touchEvent("touchmove", 320));
}

export function touchEvent(type: string, clientY: number, clientX = 0): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX, clientY }],
  });
  return event;
}

type PtyScrollTestTerminal = Terminal & {
  rows: number;
  cols: number;
  scrollToLine: ReturnType<typeof vi.fn>;
  registerMarker: ReturnType<typeof vi.fn>;
  buffer: {
    onBufferChange: ReturnType<typeof vi.fn>;
    active: {
      type: "normal" | "alternate";
      length: number;
      baseY: number;
      viewportY: number;
      cursorX: number;
      cursorY: number;
      getLine: (idx: number) => unknown;
    };
  };
};

export interface PtyScrollTestMarker {
  line: number;
  isDisposed: boolean;
  dispose: ReturnType<typeof vi.fn>;
}

export function createPtyScrollTerminal(lineTextByIndex: Record<number, string> = {}) {
  let scrollHandler: Handler = () => {};
  let renderHandler: Handler = () => {};
  let writeParsedHandler: Handler = () => {};
  let bufferChangeHandler: Handler = () => {};
  const disposeScroll = vi.fn();
  const disposeRender = vi.fn();
  const disposeWriteParsed = vi.fn();
  const disposeBufferChange = vi.fn();
  const markers: PtyScrollTestMarker[] = [];
  const scrollToLine = vi.fn((ydisp: number) => {
    terminal.buffer.active.viewportY = ydisp;
  });
  const registerMarker = vi.fn((cursorYOffset = 0) => {
    const marker: PtyScrollTestMarker = {
      line: terminal.buffer.active.baseY + terminal.buffer.active.cursorY + cursorYOffset,
      isDisposed: false,
      dispose: vi.fn(() => {
        marker.isDisposed = true;
      }),
    };
    markers.push(marker);
    return marker;
  });
  const terminal = {
    rows: 20,
    cols: 80,
    buffer: {
      onBufferChange: vi.fn((handler: Handler) => {
        bufferChangeHandler = handler;
        return { dispose: disposeBufferChange };
      }),
      active: {
        type: "normal" as "normal" | "alternate",
        length: 100,
        get baseY() {
          return Math.max(0, terminal.buffer.active.length - terminal.rows);
        },
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: (idx: number) => ({
          translateToString: () => lineTextByIndex[idx] ?? "",
        }),
      },
    },
    scrollToLine,
    registerMarker,
    onScroll: vi.fn((handler: Handler) => {
      scrollHandler = handler;
      return { dispose: disposeScroll };
    }),
    onRender: vi.fn((handler: Handler) => {
      renderHandler = handler;
      return { dispose: disposeRender };
    }),
    onWriteParsed: vi.fn((handler: Handler) => {
      writeParsedHandler = handler;
      return { dispose: disposeWriteParsed };
    }),
  } as unknown as PtyScrollTestTerminal;

  return {
    terminal,
    emitScroll: () => scrollHandler(),
    emitRender: () => renderHandler(),
    emitWriteParsed: () => writeParsedHandler(),
    emitBufferChange: () => bufferChangeHandler(),
    disposeScroll,
    disposeRender,
    disposeWriteParsed,
    disposeBufferChange,
    markers,
  };
}
