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
  let resizeObserveCalls: Element[];

  beforeEach(() => {
    resizeDisconnect = vi.fn();
    resizeObserveCalls = [];
    const observeCalls = resizeObserveCalls;
    globalThis.ResizeObserver = class {
      observe(target: Element): void {
        observeCalls.push(target);
      }
      disconnect = resizeDisconnect;
      unobserve = vi.fn();
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

  it("maps container scroll to a row-aligned xterm ydisp", () => {
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

    container.scrollTop = 45;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).toHaveBeenCalledWith(2);
    expect(host.style.top).toBe("40px");
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
  });

  it("preserves browser scroll when xterm scrolls while user is away from bottom", () => {
    const { container, spacer, host } = createDom();
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

    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 7;
    emitScroll();

    expect(container.scrollTop).toBe(100);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5);
    expect(host.style.top).toBe("100px");
  });

  it("keeps the xterm viewport on the reviewed history when new output scrolls the terminal", () => {
    const { container, spacer, host } = createDom();
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
    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 80;
    emitScroll();

    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5);
    expect(host.style.top).toBe("100px");
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

  it("keeps following when a delayed programmatic scroll event sees layout growth", () => {
    const { container, spacer, host } = createDom();
    const onAtBottomChange = vi.fn();
    let scrollHeight = 2000;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    const { terminal } = createTerminal({ 99: "latest prompt" });
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

    expect(container.scrollTop).toBe(1600);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    scrollHeight = 2024;
    container.dispatchEvent(new Event("scroll"));
    controller.relayout();

    expect(container.scrollTop).toBe(1624);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
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
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");

    defineSize(screen, { clientHeight: 600, clientWidth: 800 });
    controller.relayout();

    expect(spacer.style.height).toBe("3000px");
    expect(host.style.height).toBe("600px");
    expect(container.scrollTop).toBe(1600);
    expect(host.style.top).toBe("2400px");
  });

  it("relayout preserves xterm viewport when user is away from bottom", () => {
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
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");

    container.scrollTop = 100;
    markUserVerticalScrollIntent(container);
    terminal.buffer.active.viewportY = 7;
    defineSize(screen, { clientHeight: 600, clientWidth: 800 });
    controller.relayout();

    expect(spacer.style.height).toBe("3000px");
    expect(container.scrollTop).toBe(210);
    expect(host.style.top).toBe("210px");
  });

  it("preserves user scroll intent on initial attach even when atBottom evaluates true", () => {
    const { container, spacer, host } = createDom();
    // 让 scrollHeight 跟随 spacer.style.height —— 模拟生产 DOM 的真实层级。
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => parseFloat(spacer.style.height || "0") || 0,
    });
    const onIntentChange = vi.fn<(value: boolean) => void>();
    // 一屏大小的 buffer：updateSpacer 写完后 spacer.height = clientHeight，
    // notifyAtBottom 评为 atBottom=true，旧逻辑会清掉用户传的 intent。
    const { terminal } = createTerminal({});
    terminal.buffer.active.length = 20;

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
      onUserVerticalScrollIntentChange: onIntentChange,
    });

    // 用户 attach 时已声明 intent=true（正在回看），不应被 init 反查 atBottom 误清。
    expect(onIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("does not pin to bottom when buffer growth races onTermScroll before updateSpacer", () => {
    const { container, spacer, host } = createDom();
    // scrollHeight 跟 spacer.style.height 走，模拟真实 DOM
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => parseFloat(spacer.style.height || "0") || 0,
    });
    const { terminal, emitScroll } = createTerminal({ 19: "prompt" });
    terminal.buffer.active.length = 20;

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
    // attach 后 spacer.height = 400（一屏）。模拟 snapshot 重放让 buffer 长到 120 行：
    // xterm 内部触发 onScroll，但此时 spacer.height 还是 attach 时的旧值 400px。
    // 旧实现的 onTermScroll 在 updateSpacer 之前算 wasAtBottom=true（旧 scrollHeight 仍小），
    // 然后 updateSpacer 把 spacer 长到 2400，但 wasAtBottom 已 stale，触发 scrollToBottom 把
    // 用户拉回底部。
    terminal.buffer.active.length = 120;
    container.scrollTop = 0;
    const scrollTopBefore = container.scrollTop;
    emitScroll();

    expect(container.scrollTop).toBe(scrollTopBefore);
  });

  it("preserves intent across reconnect when an empty terminal triggers relayout", () => {
    // 复现 websocket-chaos:184 的根因：reconnect 时 scroll-controller 被重建，
    // 新 buffer 短暂为空 → 几何 atBottom=true，但用户 intent 应当跨周期保留。
    // ResizeObserver 触发首次 relayout 时 pendingFrame=none，旧实现因 wasAtBottom=true
    // 触发 scrollToBottom 清掉了 intent。修复后该分支只看 !intent 不再看 wasAtBottom。
    const { container, spacer, host } = createDom();
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => parseFloat(spacer.style.height || "0") || 0,
    });
    const onIntentChange = vi.fn<(value: boolean) => void>();
    const { terminal } = createTerminal({});
    terminal.buffer.active.length = 0;

    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      initialUserHasVerticalScrollIntent: true,
      onUserVerticalScrollIntentChange: onIntentChange,
    });

    onIntentChange.mockClear();
    // ResizeObserver 在 attach 后异步触发的首次 relayout 等价于直接调用 relayout()。
    ctrl.relayout();

    expect(onIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("only observes the scroll container (not host) to avoid feedback loop", () => {
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

    // host 的尺寸由 updateSpacer 主动写——再 observe 它就会"写→ 触发→ 重算→ 又写"。
    expect(resizeObserveCalls).toContain(container);
    expect(resizeObserveCalls).not.toContain(host);
  });

  it("does not rewrite host/spacer style when layout values are unchanged", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });

    const writeCounts: Record<string, number> = {};
    const trackStyle = (el: HTMLElement, label: string, props: string[]): void => {
      for (const prop of props) {
        let stored = "";
        Object.defineProperty(el.style, prop, {
          configurable: true,
          get: () => stored,
          set: (next: string) => {
            stored = next;
            const key = `${label}.${prop}`;
            writeCounts[key] = (writeCounts[key] ?? 0) + 1;
          },
        });
      }
    };
    trackStyle(host, "host", ["position", "left", "top", "width", "height", "paddingTop"]);
    trackStyle(spacer, "spacer", ["height", "width"]);

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
    // 让构造期的初始化 + scrollToBottom 把 cache 喂到稳定状态。
    controller.relayout();
    const settled = { ...writeCounts };

    controller.relayout();

    expect(writeCounts).toEqual(settled);
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
