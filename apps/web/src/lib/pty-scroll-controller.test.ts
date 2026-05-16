import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtyScrollController, type PtyScrollState } from "./pty-scroll-controller";
import {
  createPtyScrollDom as createDom,
  createPtyScrollTerminal as createTerminal,
  defineScrollHeight,
  defineScrollWidth,
  defineSize,
  markUserVerticalScrollIntent,
  touchEvent,
} from "./pty-scroll-controller.test-utils";

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

  // Layout and xterm viewport synchronization. These tests belong here because they assert
  // DOM scrollTop / host style / xterm viewportY side effects, not pure intent transitions.
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

  it("positions the host before changing xterm viewport at a row boundary", () => {
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
    terminal.buffer.active.viewportY = 10;
    host.style.top = "200px";
    terminal.scrollToLine.mockClear();
    let hostTopDuringScrollToLine = "";
    terminal.scrollToLine.mockImplementation((ydisp: number) => {
      hostTopDuringScrollToLine = host.style.top;
      terminal.buffer.active.viewportY = ydisp;
    });

    container.scrollTop = 199;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).toHaveBeenCalledWith(9);
    expect(hostTopDuringScrollToLine).toBe("180px");
    expect(host.style.top).toBe("180px");
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

  // Vertical intent integration. The set/clear state table lives in
  // pty-vertical-intent-fsm.test.ts; this block only proves controller events and xterm/DOM
  // side effects are wired to that FSM correctly.
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

  // scrollToBottom 默认 respect intent: 用户在回看 (intent=true) 时, 任何被动调用 (rawInput
  // echo / xterm onData 自动响应 / pendingFrame / relayout / termScroll) 都不该把视图拉走。
  // 显式 force=true 是用户明示动作 (点 BackToBottom 按钮 / init / programmaticDrift 修 stale)
  // 才能压过 intent。这把 invariant 集中在 controller 内部, 新加 caller 默认就对。
  it("scrollToBottom respects user vertical scroll intent by default (no force)", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
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
      onUserVerticalScrollIntentChange,
      initialUserHasVerticalScrollIntent: true,
    });

    container.scrollTop = 100;
    onUserVerticalScrollIntentChange.mockClear();
    terminal.scrollToLine.mockClear();

    // rawInput / pendingFrame 等被动 caller 不传 force → controller 内部默认 respect intent。
    controller.scrollToBottom("rawInput");

    expect(container.scrollTop).toBe(100);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    const intentCalls = onUserVerticalScrollIntentChange.mock.calls.map((c) => c[0]);
    expect(intentCalls).not.toContain(false);
  });

  it("scrollToBottom with force overrides user intent (BackToBottom button semantics)", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
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
      onUserVerticalScrollIntentChange,
      initialUserHasVerticalScrollIntent: true,
    });

    container.scrollTop = 100;
    onUserVerticalScrollIntentChange.mockClear();

    controller.scrollToBottom("backToBottomBtn", { force: true });

    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80);
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);
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

    // BackToBottom 按钮路径用 force: true 压过 intent (用户明示动作)。
    controller.scrollToBottom("backToBottomBtn", { force: true });
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

  // Wheel integration around cursor-aware bottom. Pure "should clear intent?" semantics are
  // FSM coverage; these tests verify controller geometry produces the right bottom signal.
  // 镜像反向: 用户主动向下滚到底, intent 应该释放, output 才能恢复跟随。
  it("releases vertical scroll intent when user wheels down back to bottom", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 300 });
    defineScrollHeight(container, 2000);
    const { terminal } = createTerminal({ 19: "prompt" });
    terminal.buffer.active.cursorY = 0;

    const onUserVerticalScrollIntentChange = vi.fn();
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onUserVerticalScrollIntentChange,
    });
    // wheel up 让 intent 进入 true, scrollTop 1600 → 1300
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, cancelable: true }));
    onUserVerticalScrollIntentChange.mockClear();

    // wheel down 把 scrollTop 拉回 1600 (光标 1600 仍在 viewport, atBottom=true 保持)
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, cancelable: true }));

    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);
  });

  it("does not wheel down past the cursor-aware bottom in longHost mode", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 300 });
    defineScrollHeight(container, 2000);
    const { terminal } = createTerminal({ 19: "prompt" });
    // longHost bottom is cursor-aware: DOM maxScrollTop is 1700, but the cursor-centered
    // anchor is 1600. Continuing to wheel down at that anchor must not push the browser
    // to the DOM geometric bottom, or pending output will pull it back and visibly jitter.
    terminal.buffer.active.cursorY = 7;

    const onUserVerticalScrollIntentChange = vi.fn();
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBe(1600);
    onUserVerticalScrollIntentChange.mockClear();

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));

    expect(container.scrollTop).toBe(1600);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(true);
  });

  it("clamps native touch scroll past cursor-aware bottom before pending output can snap back", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 5800);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1000, clientWidth: 2160 });
    const { terminal, emitRender } = createTerminal({ 265: "live prompt" });
    terminal.rows = 50;
    terminal.cols = 270;
    terminal.buffer.active.length = 288;
    terminal.buffer.active.cursorY = 27;
    let hasNewFrame = false;
    const setNewFramesWhileAway = vi.fn();
    const onUserVerticalScrollIntentChange = vi.fn();

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
    expect(container.scrollTop).toBeCloseTo(5013);

    container.dispatchEvent(touchEvent("touchstart", 320));
    onUserVerticalScrollIntentChange.mockClear();
    container.scrollTop = 5166;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBeCloseTo(5013);
    expect(terminal.buffer.active.viewportY).toBe(238);

    container.dispatchEvent(touchEvent("touchend", 280));
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);

    hasNewFrame = true;
    emitRender();

    expect(container.scrollTop).toBeCloseTo(5013);
    expect(setNewFramesWhileAway).not.toHaveBeenCalledWith(true);
  });

  it("prevents touchmove from starting native overscroll at the cursor-aware bottom", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 8380);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1000, clientWidth: 2160 });
    const { terminal } = createTerminal({ 394: "live prompt" });
    terminal.rows = 50;
    terminal.cols = 270;
    terminal.buffer.active.length = 417;
    terminal.buffer.active.cursorY = 27;
    const onUserVerticalScrollIntentChange = vi.fn();

    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBeCloseTo(7593);

    container.dispatchEvent(touchEvent("touchstart", 320));
    onUserVerticalScrollIntentChange.mockClear();
    const move = touchEvent("touchmove", 280);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);

    container.dispatchEvent(touchEvent("touchend", 280));
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);
  });

  it("snaps to cursor-aware bottom when a touchmove would cross into the native bottom gap", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 9400);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1000, clientWidth: 2160 });
    const { terminal } = createTerminal({ 445: "live prompt" });
    terminal.rows = 50;
    terminal.cols = 270;
    terminal.buffer.active.length = 468;
    terminal.buffer.active.cursorY = 27;

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
    expect(container.scrollTop).toBeCloseTo(8613);

    container.scrollTop = 8605;
    container.dispatchEvent(touchEvent("touchstart", 320));
    const move = touchEvent("touchmove", 300);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
    expect(container.scrollTop).toBeCloseTo(8613);
  });

  it("does not re-center on passive output when keyboard height jitters but cursor remains visible", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "112px";
    defineSize(container, { clientHeight: 347, clientWidth: 360 });
    defineScrollHeight(container, 8920);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1000, clientWidth: 2160 });
    const { terminal, emitRender } = createTerminal({ 417: "live prompt" });
    terminal.rows = 50;
    terminal.cols = 270;
    terminal.buffer.active.length = 440;
    terminal.buffer.active.cursorY = 27;
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
      setNewFramesWhileAway: vi.fn(),
    });
    expect(container.scrollTop).toBeCloseTo(8236.5);

    defineSize(container, { clientHeight: 365 });
    hasNewFrame = true;
    emitRender();

    expect(container.scrollTop).toBeCloseTo(8236.5);
  });

  it("keeps vertical review intent on a small wheel-down while still far from bottom (longHost)", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 787, clientWidth: 1640 });
    defineScrollHeight(container, 4990);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 936, clientWidth: 2160 });
    const { terminal } = createTerminal({ 109: "reviewed prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 275;
    terminal.buffer.active.viewportY = 80;
    terminal.buffer.active.cursorY = 29;

    const onUserVerticalScrollIntentChange = vi.fn();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      initialUserHasVerticalScrollIntent: true,
      onUserVerticalScrollIntentChange,
    });
    controller.relayout();
    expect(container.scrollTop).toBe(1440);
    onUserVerticalScrollIntentChange.mockClear();

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));

    expect(container.scrollTop).toBe(1560);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("treats long-host history review as away from live cursor even when viewport-local cursor is visible", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 5340);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1000, clientWidth: 2160 });
    const { terminal, emitRender } = createTerminal({ 242: "live prompt" });
    terminal.rows = 50;
    terminal.cols = 270;
    terminal.buffer.active.length = 265;
    terminal.buffer.active.cursorY = 27;

    const onUserVerticalScrollIntentChange = vi.fn();
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBeCloseTo(4533);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1800, cancelable: true }));

    expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY);
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
    const reviewedScrollTop = container.scrollTop;
    onUserVerticalScrollIntentChange.mockClear();

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
    emitRender();

    expect(container.scrollTop).toBeCloseTo(reviewedScrollTop + 120);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(false);
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

  // Horizontal scroll is intentionally not part of the vertical intent FSM. Keep these tests
  // in controller coverage until horizontal scrolling gets its own model.
  // 长行(终端宽度 cols=80, 内容延伸到 cols * 2 等), 光标随输入移到屏外右侧时,
  // 水平滚动条应该自动把光标拉回视窗中部, 留出左右上下文而不是贴着光标。
  it("auto-scrolls horizontally to center the cursor when it leaves the viewport", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
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

    // cellW = screen.clientWidth / cols = 800 / 80 = 10. cursorX=120 → cursor 像素位置 1200,
    // viewport 是 [0, 800), 已经 hit 屏外右侧 400px。
    terminal.buffer.active.cursorX = 120;
    emitRender();

    // 中心目标: cursorPxX - clientWidth/2 = 1200 - 400 = 800
    expect(container.scrollLeft).toBe(800);
  });

  it("does not adjust horizontal scroll when the cursor is already in view", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
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
    container.scrollLeft = 200;

    terminal.buffer.active.cursorX = 50; // cursorPxX = 500, viewport [200, 1000) -> in view
    emitRender();

    expect(container.scrollLeft).toBe(200);
  });

  // 用户手动滚到右侧后, terminal 把光标拉回行首 (\r 或 Ctrl+A) — 光标在视窗左外侧,
  // 应自动回滚让其居中, 否则用户看不到自己刚到的输入位置。
  it("auto-scrolls horizontally back when the cursor falls left of the viewport", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
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
    container.scrollLeft = 800; // 用户手动滚到右半边

    terminal.buffer.active.cursorX = 5; // cursorPxX = 50, 落在 viewport [800, 1600) 左外侧
    emitRender();

    // 中心目标: 50 - 400 = -350, clamp 到 0
    expect(container.scrollLeft).toBe(0);
  });

  // 光标贴最右端时, target 会超过 maxScrollLeft, 必须 clamp 否则 scrollLeft 越界。
  it("clamps horizontal auto-scroll to the rightmost reachable scroll position", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
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

    // cursorX=160 → cursorPxX=1600 (行尾), target=1200 但 maxScrollLeft=800 (1600-800)
    terminal.buffer.active.cursorX = 160;
    emitRender();

    expect(container.scrollLeft).toBe(800);
  });

  // 内容没溢出时不能动 scrollLeft, 否则在小终端上无故抖屏。
  it("leaves horizontal scroll alone when the terminal content fits the viewport", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 800); // == clientWidth, 不溢出
    const { terminal, emitRender } = createTerminal({ 19: "prompt" });
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
    container.scrollLeft = 0;

    terminal.buffer.active.cursorX = 200; // 即使 cursor 数值"出框"也不该动
    emitRender();

    expect(container.scrollLeft).toBe(0);
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

  // Relayout and transient measurement recovery. These cases protect cellH=0 / stale layout
  // races and should not move into the pure intent FSM.
  it("relayout keeps cursor pinned in viewport after terminal metrics make host taller than container", () => {
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

    // 屏幕变大让 cellH 从 20 涨到 30, host 高度变 600 而容器仍 400 → host > viewport。
    // 真实浏览器会随 spacer.style.height 同步刷 container.scrollHeight, 在 jsdom 里手动同步。
    defineSize(screen, { clientHeight: 600, clientWidth: 800 });
    defineScrollHeight(container, 3000);
    controller.relayout();

    expect(spacer.style.height).toBe("3000px");
    expect(host.style.height).toBe("600px");
    // scrollTop 不再是 scrollHeight-clientHeight (=2600), 而是 maxYdisp*cellH=2400, 把光标
    // 行(buffer 第 80 行, cursorY=0)放到视窗顶部; 否则 host 上半段被剪到视窗外, 光标看不见。
    // 用 cursor 而非几何底是因为 buffer 末尾常有 trailing empty rows, 几何贴底反而空。
    expect(container.scrollTop).toBe(2400);
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
    // attach 后 spacer.height=400(一屏)。模拟 snapshot 重放让 buffer 长到 120 行,
    // xterm 内部触发 onScroll, 此时 spacer.height 仍是 attach 时的 400px, scrollHeight
    // 还没反映新 buffer 长度。invariant: onTermScroll 必须先 updateSpacer 再算
    // wasAtBottom, 否则用 stale scrollHeight 算出 atBottom=true 会触发 scrollToBottom
    // 把用户拉回底部, 抹掉用户已存在的 vertical scroll intent。
    terminal.buffer.active.length = 120;
    container.scrollTop = 0;
    const scrollTopBefore = container.scrollTop;
    emitScroll();

    expect(container.scrollTop).toBe(scrollTopBefore);
  });

  it("preserves intent across reconnect when an empty terminal triggers relayout", () => {
    // 复现 websocket-chaos:184 的根因: reconnect 时 scroll-controller 被重建,
    // 新 buffer 短暂为空 → 几何 atBottom=true, 但用户 intent 必须跨周期保留。
    // invariant: empty-buffer + relayout 路径 (pendingFrame=none) 不能调 scrollToBottom
    // 抹掉 intent — 该分支只看 !intent, 不看 wasAtBottom。
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

  it("recovers host position after a transient cellH=0 measurement window", () => {
    // 移动端 production blank-render 候选成因之一: WebGL canvas 在某帧 measure 不到尺寸
    // (xterm-screen 暂时 0 高 / 还没 attach), getDims 返回 cellH=0。这帧用户若发生滚动,
    // syncContainerScroll 早返回不动 host, host.style.top 卡在上一次有效值上, viewportY
    // 也没跟着 scrollTop 走。下一次 cellH 恢复到正常 (onRender / relayout 收到通知) 时
    // 必须把这次 stale 的 scroll 补上,否则 host 永远停在旧位置——视觉上就是上半截全黑。
    const { container, spacer, host, xterm } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const { terminal } = createTerminal({ 19: "prompt" });

    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    // 初始 cellH=400/20=20, scrollTop=200 → ydisp=10, host.top=200
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));
    expect(host.style.top).toBe("200px");

    // 模拟"canvas 不可测"的瞬间: xterm-screen clientHeight 跌成 0 → cellH=0
    defineSize(screen, { clientHeight: 0, clientWidth: 0 });
    container.scrollTop = 600;
    container.dispatchEvent(new Event("scroll"));
    // 此时 syncContainerScroll 早返回, host.top 滞留在 stale 值 (=200px) ——这是 bug 的种子。
    expect(host.style.top).toBe("200px");

    // 测量恢复到正常 (canvas 完成首次绘制 / WebGL context 恢复)。
    // onRender / relayout 触发时, controller 必须自检"用户 scrollTop 与 host 是否对得上",
    // 不一致就补一遍 syncContainerScroll, 让 host 跳到 600 对应的 ydisp=30, host.top=600。
    defineSize(screen, { clientHeight: 400, clientWidth: 800 });
    ctrl.relayout();

    expect(host.style.top).toBe("600px");
    void xterm;
  });

  it("treats missing .xterm-screen as cellH=0 and queues retry", () => {
    // measureXtermCellSize 三条 null 路径之一: .xterm-screen 节点不存在
    // (xterm 还没 open / 已经 dispose 了 inner DOM)。fix 不依赖具体触发器,只看 cellH——
    // 但测试要把这条路径也覆盖到,免得未来重构改 measure 实现时这条 invariant 失守。
    const { container, spacer, host } = createDom();
    host.querySelector(".xterm-screen")?.remove();
    const { terminal } = createTerminal({ 19: "prompt" });

    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    container.scrollTop = 600;
    container.dispatchEvent(new Event("scroll"));
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(true);
  });

  it("treats term.cols=0 as cellH=0 and queues retry", () => {
    // measureXtermCellSize 另一条 null 路径: term.cols<=0 || term.rows<=0。
    // 移动端键盘 show/hide 时 container 短暂被压扁, xterm 内部 reflow 可能让 cols 临时为 0。
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 19: "prompt" });
    // 先正常 attach (init 期间 cols=80 拿到正常 cellH), 再把 cols 砍掉
    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    (terminal as unknown as { cols: number }).cols = 0;
    container.scrollTop = 600;
    container.dispatchEvent(new Event("scroll"));
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(true);
  });

  it("clears pendingContainerSyncRetry when scrollToBottom takes over the scroll position", () => {
    // scrollToBottom 重写 scrollTop 到底, 上一次 cellH=0 漏掉的"按 user scroll 重对齐"语义就此失效。
    // flag 留 true 不破坏正确性 (再 sync 一遍是 no-op), 但语义不真——审计中应当显式 reset。
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const { terminal } = createTerminal({ 19: "prompt" });

    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    // 触发 cellH=0 → 用户 scroll → flag 置 true。container.scroll 同时 set intent=true。
    defineSize(screen, { clientHeight: 0, clientWidth: 0 });
    container.scrollTop = 600;
    container.dispatchEvent(new Event("scroll"));
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(true);

    // 用户点 BackToBottom 用 force: true 路径压过 intent, 必须清掉 flag。
    ctrl.scrollToBottom("backToBottomBtn", { force: true });
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(false);
  });

  it("scrollToBottom keeps flag clear even when cellH=0 during the synthetic scroll event", () => {
    // 边界场景: scrollToBottom 末尾的 container.scrollTop=nextScrollTop 写入会同步触发
    // onContainerScroll → syncContainerScroll, 这时如果 cellH 还是 0, syncContainerScroll
    // 会再次把 flag 置 true。clear 必须在所有同步副作用之后, 否则 scrollToBottom 的语义"清干净
    // stale state"不真。
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const { terminal } = createTerminal({ 19: "prompt" });

    const ctrl = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
    });

    // cellH=0 整段都保持: scrollToBottom 期间 + 同步副作用 onContainerScroll 期间都 measure 不到。
    defineSize(screen, { clientHeight: 0, clientWidth: 0 });
    ctrl.scrollToBottom();
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(false);
  });

  // Observer/lifecycle hygiene.
  // syncing.{internal,external} 泄漏审查记录:
  //   - syncing.internal: 仅在 scrollToYdisp / scrollToBottom 里围着 term.scrollToLine 那一行 set/restore,
  //     try/finally 保证 scrollToLine 抛错也会复位。其它语句 (positionHostAt / scrollTop 写入 / notifyScroll)
  //     运行时 syncing.internal 已经是 false, 抛错也不污染 flag。
  //   - syncing.external: 仅在 onTermScroll 整段 try/finally 围住, finally 里 restore。
  // 模拟 scrollToLine throw 的回归测试在 jsdom 下被作为 unhandled error 上报,污染下一个 test。
  // 这条 invariant 改由静态审查 + cellH 恢复测试一起兜——前者保证 syncing 不卡, 后者保证 host 不卡。

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

  // proxy-hosted PTY: xterm.rows 来自 server (52 行, host=1040px), mobile 容器键盘弹起后
  // 压扁到 200px。host > viewport 时, buffer 末尾常常是 trailing empty rows (claude prompt
  // 之后即空), 纯几何贴底反而显示空白把真内容推出视窗 → 用 cursor 行作为锚点。
  describe("when host is taller than viewport (server-owned rows + mobile keyboard)", () => {
    function setupTallHost(opts: { cursorY: number; viewportY?: number }) {
      const { container, spacer, host, xterm } = createDom();
      defineSize(container, { clientHeight: 200, clientWidth: 800 });
      const screen = host.querySelector(".xterm-screen") as HTMLElement;
      defineSize(screen, { clientHeight: 1040, clientWidth: 800 });
      const { terminal, emitRender, emitScroll } = createTerminal({});
      terminal.rows = 52;
      terminal.buffer.active.length = 905;
      terminal.buffer.active.viewportY = opts.viewportY ?? 853;
      terminal.buffer.active.cursorY = opts.cursorY;
      // spacer = max(905*20, 853*20+200) = 18100; padding=0 in tests so scrollHeight matches.
      defineScrollHeight(container, 18100);
      return { container, spacer, host, xterm, terminal, emitRender, emitScroll };
    }

    function attach(
      params: ReturnType<typeof setupTallHost>,
      extra: Partial<Parameters<typeof attachPtyScrollController>[0]> = {},
    ) {
      const { container, spacer, host, terminal } = params;
      return attachPtyScrollController({
        container,
        spacer,
        host,
        term: terminal,
        hasNewFrame: () => false,
        consumeNewFrame: vi.fn(),
        hasNewFramesWhileAway: () => false,
        setNewFramesWhileAway: vi.fn(),
        ...extra,
      });
    }

    it("anchors viewport on cursor row when host > vch on entry (geometric bottom would land on trailing empty rows)", () => {
      const params = setupTallHost({ cursorY: 0 });
      attach(params);
      // 几何贴底是 17900, 但那块在 buffer trailing empty 区。光标在 row 853 (host top), 像素 17060。
      // computeBottomScrollTop: target = 17060 - (200-20)/2 = 16970, 夹到 minScrollTop=17060
      // (= maxYdisp*cellH, 再低就改 ydisp 了) → 光标停在视窗顶部行。
      expect(params.container.scrollTop).toBe(17060);
    });

    it("centers cursor when cursor sits mid-host on entry", () => {
      const params = setupTallHost({ cursorY: 25 });
      attach(params);
      // cursorBufferRow=878, cursorPx=17560, target=17560-(200-20)/2=17470, 在 [17060, 17900] 内。
      expect(params.container.scrollTop).toBe(17470);
    });

    it("first onRender after entry leaves scrollTop alone when cursor row is unchanged", () => {
      const params = setupTallHost({ cursorY: 25 });
      attach(params);
      expect(params.container.scrollTop).toBe(17470);

      // focus 切换 / theme 重绘 类的"无变动 onRender"不能掀构图。followCursorY 仅在光标行
      // 真的变了那一帧介入 (prevCursorBufferRow guard)。
      params.emitRender();
      expect(params.container.scrollTop).toBe(17470);
    });

    it("followCursorY re-centers when cursor moves to a row outside the current viewport", () => {
      const params = setupTallHost({ cursorY: 0 });
      attach(params);
      // 进入: scrollTop=17060, 视窗 [17068, 17260]。光标 cursorBufferRow=853, pixel 17060,
      // 在视窗顶 (cursorPx >= viewportTop)。
      expect(params.container.scrollTop).toBe(17060);

      // 光标跳到 row 25 (cursorBufferRow=878, pixel 17560), 不在 [17068, 17260] 内。
      params.terminal.buffer.active.cursorY = 25;
      params.emitRender();

      expect(params.container.scrollTop).toBe(17470);
    });

    it("reports atBottom=true under cursor-aware path because cursor is in viewport", () => {
      const params = setupTallHost({ cursorY: 25 });
      const onAtBottomChange = vi.fn();
      attach(params, { onAtBottomChange });
      // scrollTop=17470 离几何底 17900 还有距离, 但 host > vch 分支看的是"光标在视窗内", 是 →
      // BackToBottom 不该亮。
      expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
    });

    it("does not auto-scroll when user has expressed scroll intent (entry or follow)", () => {
      const params = setupTallHost({ cursorY: 0 });
      attach(params, { initialUserHasVerticalScrollIntent: true });
      // intent=true 时进入既不 scrollToBottom 也不 followCursorY, scrollTop 保持 0 (默认)。
      expect(params.container.scrollTop).toBe(0);

      params.terminal.buffer.active.cursorY = 25;
      params.emitRender();
      // 光标动了也不抢: 用户主动回看路径神圣不可侵犯。
      expect(params.container.scrollTop).toBe(0);
    });
  });
});
