import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtyScrollController, type PtyScrollState } from "./pty-scroll-controller";

type Handler = () => void;

function defineSize(el: HTMLElement, sizes: { clientHeight?: number; clientWidth?: number }): void {
  if (sizes.clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  }
  if (sizes.clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
  }
}

function defineScrollHeight(el: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
}

function defineScrollWidth(el: HTMLElement, scrollWidth: number): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
}

function createDom() {
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

function markUserVerticalScrollIntent(container: HTMLElement): void {
  container.dispatchEvent(new Event("touchstart"));
}

function touchEvent(type: string, clientY: number): TouchEvent {
  const event = new Event(type, { bubbles: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: type === "touchend" || type === "touchcancel" ? [] : [{ clientY }],
  });
  return event;
}

function createTerminal(lineTextByIndex: Record<number, string> = {}) {
  let scrollHandler: Handler = () => {};
  let renderHandler: Handler = () => {};
  const disposeScroll = vi.fn();
  const disposeRender = vi.fn();
  const scrollToLine = vi.fn((ydisp: number) => {
    terminal.buffer.active.viewportY = ydisp;
  });
  const terminal = {
    rows: 20,
    cols: 80,
    buffer: {
      active: {
        length: 100,
        viewportY: 0,
        getLine: (idx: number) => ({
          translateToString: () => lineTextByIndex[idx] ?? "",
        }),
      },
    },
    scrollToLine,
    onScroll: vi.fn((handler: Handler) => {
      scrollHandler = handler;
      return { dispose: disposeScroll };
    }),
    onRender: vi.fn((handler: Handler) => {
      renderHandler = handler;
      return { dispose: disposeRender };
    }),
  } as unknown as Terminal & {
    scrollToLine: ReturnType<typeof vi.fn>;
    buffer: { active: { length: number; viewportY: number; getLine: (idx: number) => unknown } };
  };

  return {
    terminal,
    emitScroll: () => scrollHandler(),
    emitRender: () => renderHandler(),
    disposeScroll,
    disposeRender,
  };
}

describe("attachPtyScrollController", () => {
  let resizeDisconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resizeDisconnect = vi.fn();
    globalThis.ResizeObserver = class {
      observe = vi.fn();
      disconnect = resizeDisconnect;
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes spacer and host layout from xterm metrics", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });

    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    expect(spacer.style.height).toBe("2000px");
    expect(spacer.style.width).toBe("800px");
    expect(host.style.width).toBe("800px");
    expect(host.style.height).toBe("400px");
    expect(host.style.paddingTop).toBe("0px");
    expect(container.scrollTop).toBe(1600);
  });

  it("maps container scroll to xterm ydisp while browser owns subpixel motion", () => {
    const { container, spacer, host, xterm } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    container.scrollTop = 45;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).toHaveBeenCalledWith(2);
    expect(host.style.top).toBe("40px");
    expect(xterm.style.transform).toBe("");
  });

  it("syncs native touch scroll to the matching terminal row immediately", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { container, spacer, host, xterm } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 320));
    container.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 145;
    container.dispatchEvent(new Event("scroll"));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(7);
    expect(host.style.top).toBe("140px");
    expect(xterm.style.transform).toBe("");
  });

  it("preserves browser scroll when xterm scrolls while user is away from bottom", () => {
    const { container, spacer, host, xterm } = createDom();
    const { terminal, emitScroll } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    xterm.style.transform = "translate3d(0,-5px,0)";
    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 7;
    emitScroll();

    expect(container.scrollTop).toBe(100);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5);
    expect(host.style.top).toBe("100px");
    expect(xterm.style.transform).toBe("");
  });

  it("keeps the xterm viewport on the reviewed history when new output scrolls the terminal", () => {
    const { container, spacer, host, xterm } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitScroll } = createTerminal({ 19: "prompt" });
    let hasNewFrame = true;
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => hasNewFrame,
      consumeNewFrame: () => {
        hasNewFrame = false;
      },
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
    });

    terminal.scrollToLine.mockClear();
    xterm.style.transform = "translate3d(0,-5px,0)";
    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 80;
    emitScroll();

    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5);
    expect(host.style.top).toBe("100px");
    expect(xterm.style.transform).toBe("");
  });

  it("keeps the browser scroll pinned when xterm scrolls after content growth at bottom", () => {
    const { container, spacer, host } = createDom();
    let scrollHeight = 2000;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    const { terminal, emitScroll } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    expect(container.scrollTop).toBe(1600);

    terminal.buffer.active.length = 110;
    terminal.buffer.active.viewportY = 90;
    scrollHeight = 2200;
    emitScroll();

    expect(container.scrollTop).toBe(1800);
  });

  it("follows to bottom on render when a real new frame arrives at bottom", () => {
    const { container, spacer, host } = createDom();
    const consumeNewFrame = vi.fn();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => true,
      consumeNewFrame,
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
    });

    emitRender();

    expect(consumeNewFrame).toHaveBeenCalledTimes(1);
    expect(container.scrollTop).toBe(1600);
    expect(setNewFramesWhileAway).not.toHaveBeenCalled();
  });

  it("keeps following when a new frame increases scroll height while pinned", () => {
    const { container, spacer, host } = createDom();
    const consumeNewFrame = vi.fn();
    const setNewFramesWhileAway = vi.fn();
    let scrollHeight = 2000;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
    terminal.buffer.active.length = 100;
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => true,
      consumeNewFrame,
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
    });

    expect(container.scrollTop).toBe(1600);

    terminal.buffer.active.length = 110;
    scrollHeight = 2200;
    emitRender();

    expect(consumeNewFrame).toHaveBeenCalledTimes(1);
    expect(container.scrollTop).toBe(1800);
    expect(setNewFramesWhileAway).not.toHaveBeenCalled();
  });

  it("marks unseen frames when render happens away from bottom", () => {
    const { container, spacer, host } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => true,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
    });

    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    emitRender();

    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
  });

  it("keeps touch review intent through output that renders before native scroll moves", () => {
    const { container, spacer, host } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
    let hasNewFrame = true;
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => hasNewFrame,
      consumeNewFrame: () => {
        hasNewFrame = false;
      },
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
      onUserVerticalScrollIntentChange,
    });

    container.dispatchEvent(new Event("touchstart"));
    emitRender();

    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("notifies when a touch gesture becomes vertical terminal review", () => {
    const { container, spacer, host } = createDom();
    const onTouchReviewStart = vi.fn();
    const { terminal } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onTouchReviewStart,
    });

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchmove", 295));
    expect(onTouchReviewStart).not.toHaveBeenCalled();

    container.dispatchEvent(touchEvent("touchmove", 280));
    container.dispatchEvent(touchEvent("touchmove", 250));
    expect(onTouchReviewStart).toHaveBeenCalledTimes(1);

    container.dispatchEvent(touchEvent("touchend", 250));
    container.dispatchEvent(touchEvent("touchstart", 250));
    container.dispatchEvent(touchEvent("touchmove", 270));
    expect(onTouchReviewStart).toHaveBeenCalledTimes(2);
  });

  it("treats native container scrolling away from bottom as user review intent", () => {
    const { container, spacer, host } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
    let hasNewFrame = false;
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => hasNewFrame,
      consumeNewFrame: () => {
        hasNewFrame = false;
      },
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
    });

    container.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    hasNewFrame = true;
    emitRender();

    expect(container.scrollTop).toBe(100);
    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
  });

  it("preserves user scroll intent when controller is reattached", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    container.scrollTop = 100;

    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      initialUserHasVerticalScrollIntent: true,
    });

    expect(container.scrollTop).toBe(100);
  });

  it("marks unseen frames on relayout even when xterm does not render the hidden frame", () => {
    const { container, spacer, host } = createDom();
    const consumeNewFrame = vi.fn();
    const setNewFramesWhileAway = vi.fn();
    const { terminal } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => true,
      consumeNewFrame,
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway,
      initialUserHasVerticalScrollIntent: true,
    });

    controller.relayout();

    expect(consumeNewFrame).toHaveBeenCalledTimes(1);
    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(container.scrollTop).toBe(0);
  });

  it("owns at-bottom state and exposes scrollToBottom", () => {
    const { container, spacer, host } = createDom();
    const onAtBottomChange = vi.fn();
    const { terminal } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onAtBottomChange,
    });

    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    container.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);

    controller.scrollToBottom();
    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it("syncs xterm viewport to bottom on initial layout", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "latest prompt" });
    terminal.buffer.active.viewportY = 10;

    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(container.scrollTop).toBe(1600);
    expect(host.style.top).toBe("1600px");
  });

  it("publishes scroll state changes without duplicating identical snapshots", () => {
    const { container, spacer, host } = createDom();
    const onScrollStateChange = vi.fn<(state: PtyScrollState) => void>();
    const { terminal } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onScrollStateChange,
    });

    expect(onScrollStateChange).toHaveBeenLastCalledWith({
      scrollTop: 1600,
      scrollLeft: 0,
      scrollHeight: 2000,
      scrollWidth: 800,
      clientHeight: 400,
      clientWidth: 800,
      scrollable: true,
      horizontalScrollable: false,
    });
    const initialCalls = onScrollStateChange.mock.calls.length;

    container.dispatchEvent(new Event("scroll"));
    expect(onScrollStateChange).toHaveBeenCalledTimes(initialCalls);

    container.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    expect(onScrollStateChange).toHaveBeenLastCalledWith({
      scrollTop: 100,
      scrollLeft: 0,
      scrollHeight: 2000,
      scrollWidth: 800,
      clientHeight: 400,
      clientWidth: 800,
      scrollable: true,
      horizontalScrollable: false,
    });
  });

  it("exposes ratio scrolling for a custom terminal scrollbar", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    terminal.scrollToLine.mockClear();

    controller.scrollToRatio(0.5);

    expect(container.scrollTop).toBe(800);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(40);
  });

  it("owns wheel scrolling instead of leaving it to xterm internals", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    terminal.scrollToLine.mockClear();

    const event = new WheelEvent("wheel", { deltaY: -300, cancelable: true });
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(container.scrollTop).toBe(1300);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(65);
  });

  it("exposes ratio scrolling for a custom horizontal terminal scrollbar", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal } = createTerminal({ 19: "prompt" });
    const onScrollStateChange = vi.fn<(state: PtyScrollState) => void>();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onScrollStateChange,
    });

    controller.scrollToXRatio(0.5);

    expect(container.scrollLeft).toBe(400);
    expect(onScrollStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scrollLeft: 400,
        scrollWidth: 1600,
        clientWidth: 800,
        horizontalScrollable: true,
      }),
    );
  });

  it("relayout keeps bottom pinned after terminal metrics change", () => {
    const { container, spacer, host, xterm } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");

    defineSize(screen, { clientHeight: 600, clientWidth: 800 });
    controller.relayout();

    expect(spacer.style.height).toBe("3000px");
    expect(host.style.height).toBe("600px");
    expect(container.scrollTop).toBe(1600);
    expect(host.style.top).toBe("2400px");
    expect(xterm.style.transform).toBe("");
  });

  it("relayout preserves xterm viewport when user is away from bottom", () => {
    const { container, spacer, host, xterm } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");

    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 7;
    xterm.style.transform = "translate3d(0,-5px,0)";
    defineSize(screen, { clientHeight: 600, clientWidth: 800 });
    controller.relayout();

    expect(spacer.style.height).toBe("3000px");
    expect(container.scrollTop).toBe(210);
    expect(host.style.top).toBe("210px");
    expect(xterm.style.transform).toBe("");
  });

  it("cleans up DOM, xterm, and resize observers", () => {
    const { container, spacer, host } = createDom();
    const { terminal, disposeScroll, disposeRender } = createTerminal({ 19: "prompt" });
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });
    terminal.scrollToLine.mockClear();

    controller.dispose();
    container.scrollTop = 45;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(disposeScroll).toHaveBeenCalledTimes(1);
    expect(disposeRender).toHaveBeenCalledTimes(1);
    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
  });
});
