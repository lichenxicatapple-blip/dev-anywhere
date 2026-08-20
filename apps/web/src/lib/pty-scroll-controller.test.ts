import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtyScrollController, type PtyScrollState } from "./pty-scroll-controller";
import { buildPtyScrollDebugSnapshot } from "./pty-scroll-debug-snapshot";
import type { PtyHistoryProjection } from "./pty-history-projection";
import {
  createPtyScrollDom as createDom,
  createPtyScrollTerminal as createTerminal,
  defineScrollHeight,
  defineScrollWidth,
  defineSize,
  markUserVerticalScrollIntent,
  touchEvent,
} from "./pty-scroll-controller.test-utils";

function createHistoryProjectionRenderer() {
  return vi.fn<(projection: PtyHistoryProjection | null) => boolean>(() => true);
}

function getHistoryProjections(
  renderer: ReturnType<typeof createHistoryProjectionRenderer>,
  kind: PtyHistoryProjection["kind"],
): PtyHistoryProjection[] {
  return renderer.mock.calls.flatMap(([projection]) =>
    projection?.kind === kind ? [projection] : [],
  );
}

function getHistoryProjectionClearCount(
  renderer: ReturnType<typeof createHistoryProjectionRenderer>,
): number {
  return renderer.mock.calls.filter(([projection]) => projection === null).length;
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
    window.history.replaceState(null, "", "/");
    window.localStorage.removeItem("dev_anywhere_pty_scroll_trace");
    (window as unknown as { __devAnywherePtyScrollTrace?: unknown }).__devAnywherePtyScrollTrace =
      undefined;
  });

  // Layout and xterm viewport synchronization. These tests belong here because they assert
  // DOM scrollTop / host style / xterm viewportY side effects, not pure intent transitions.
  it("initializes spacer and host layout from xterm metrics", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });

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

  it("backfills a short live host from real scrollback after review exits", () => {
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(container, { clientHeight: 597 });
    defineSize(screen, { clientHeight: 500 });
    defineScrollHeight(container, 40_855);
    const { terminal } = createTerminal();
    terminal.rows = 25;
    terminal.buffer.active.length = 2035;
    terminal.buffer.active.cursorY = 24;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    expect(container.scrollTop).toBe(40_200);
    expect(terminal.buffer.active.viewportY).toBe(2010);
    expect(host.style.top).toBe("40297px");
    expect(getHistoryProjections(renderProjection, "live-backfill").at(-1)).toEqual({
      kind: "live-backfill",
      startLine: 2005,
      endLine: 2009,
      rowHeight: 20,
      topOffset: -100,
    });

    controller.markSelectionAutoscrollIntent("test review");
    expect(getHistoryProjections(renderProjection, "review")).not.toHaveLength(0);
    const callsBeforeReturn = renderProjection.mock.calls.length;

    controller.scrollToBottom("test return", { force: true });

    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(
      renderProjection.mock.calls
        .slice(callsBeforeReturn)
        .some(([projection]) => projection === null),
    ).toBe(true);
    expect(getHistoryProjections(renderProjection, "live-backfill").at(-1)).toEqual({
      kind: "live-backfill",
      startLine: 2005,
      endLine: 2009,
      rowHeight: 20,
      topOffset: -100,
    });
  });

  it("positions a short live host before publishing the repaired xterm viewport", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "8px";
    defineSize(container, { clientHeight: 910, clientWidth: 1640 });
    defineScrollHeight(container, 21_322);
    defineScrollWidth(container, 1640);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 666, clientWidth: 1432 });
    const { terminal, emitRender } = createTerminal({ 1170: "last painted live row" });
    terminal.rows = 37;
    terminal.cols = 179;
    terminal.buffer.active.length = 1172;
    terminal.buffer.active.cursorY = 33;
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

    expect(container.scrollTop).toBe(20_412);
    expect(terminal.buffer.active.baseY).toBe(1135);
    expect(terminal.buffer.active.viewportY).toBe(1134);
    expect(host.style.top).toBe("20640px");

    // Reproduce the split frame from the field trace: xterm has moved to its physical baseY and
    // host followed it, while the semantic DOM bottom still belongs to viewport 1134. Repair must
    // publish host + viewport from one plan; an xterm scroll observer must never see the new row
    // paired with the stale 20658px host.
    terminal.buffer.active.viewportY = 1135;
    emitRender();
    expect(host.style.top).toBe("20658px");
    terminal.scrollToLine.mockClear();
    const observations: Array<{ ydisp: number; hostTop: string; scrollTop: number }> = [];
    terminal.scrollToLine.mockImplementation((ydisp: number) => {
      observations.push({ ydisp, hostTop: host.style.top, scrollTop: container.scrollTop });
      terminal.buffer.active.viewportY = ydisp;
    });

    controller.scrollToBottom("repair-split-frame", { force: true });

    expect(observations).toEqual([{ ydisp: 1134, hostTop: "20640px", scrollTop: 20_412 }]);
    expect(terminal.buffer.active.viewportY).toBe(1134);
    expect(host.style.top).toBe("20640px");
    expect(container.scrollTop).toBe(20_412);
  });

  it("maps custom ratio scrolling to a row-aligned xterm ydisp", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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

    controller.scrollToRatio(45 / 1600);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(2);
    expect(host.style.top).toBe("40px");
  });

  it("registers touchmove passively so native touch scroll is not blocked on JS", () => {
    const { container, spacer, host } = createDom();
    const addEventListener = container.addEventListener.bind(container);
    const listenerOptions = new Map<string, AddEventListenerOptions | boolean | undefined>();
    vi.spyOn(container, "addEventListener").mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        listenerOptions.set(type, options);
        addEventListener(type, listener, options);
      },
    );
    const { terminal } = createTerminal({ 99: "prompt" });

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

    expect(listenerOptions.get("touchmove")).toEqual({ passive: true });
  });

  it("positions the host before changing xterm viewport at a row boundary", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    // Establish the row through the controller so DOM scrollTop, xterm viewportY and host.top
    // describe one rendered frame before the next native event arrives.
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1400, cancelable: true }));
    expect(terminal.buffer.active.viewportY).toBe(10);
    expect(host.style.top).toBe("200px");
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

  it("defers host row jumps during native touch scroll until xterm renders the new row", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    container.dispatchEvent(touchEvent("touchstart", 320));
    container.scrollTop = 199.7;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).toHaveBeenCalledWith(9);
    expect(host.style.top).toBe("200px");

    container.dispatchEvent(new Event("scroll"));

    expect(host.style.top).toBe("200px");

    emitRender();

    expect(host.style.top).toBe("180px");
  });

  it("anchors review to the painted row before committing later native rows atomically", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
    const preview = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: preview,
    });
    terminal.buffer.active.viewportY = 10;
    host.style.top = "200px";
    terminal.scrollToLine.mockClear();

    container.scrollTop = 199.7;
    controller.markSelectionAutoscrollIntent("test-owned review");
    container.dispatchEvent(new Event("scroll"));

    // The DOM offset sits just below the 200px row boundary, so a sliver of row 9 is physically
    // visible while xterm viewport 10 still covers the live screen. Snapshot and xterm viewport
    // are deliberately separate: capture row 9 with a -20px shell offset without moving xterm.
    expect(getHistoryProjections(preview, "review").at(-1)).toEqual(
      expect.objectContaining({
        kind: "review",
        startLine: 9,
        endLine: 9 + terminal.rows + 1,
        rowHeight: 20,
        topOffset: -20,
      }),
    );
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(host.style.top).toBe("200px");

    container.scrollTop = 179.7;
    container.dispatchEvent(new Event("scroll"));

    expect(getHistoryProjections(preview, "review").at(-1)).toEqual(
      expect.objectContaining({
        kind: "review",
        startLine: 8,
        endLine: 8 + terminal.rows + 1,
        rowHeight: 20,
        topOffset: -20,
      }),
    );
    expect(terminal.scrollToLine).toHaveBeenCalledWith(9);
    expect(preview.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY).toBeLessThan(
      terminal.scrollToLine.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(host.style.top).toBe("180px");
  });

  it("does not advance one row when a slow touch claims an unchanged short-host frame", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 741, clientWidth: 411 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 552, clientWidth: 768 });
    const { terminal } = createTerminal();
    terminal.rows = 29;
    terminal.buffer.active.length = 5029;
    terminal.buffer.active.cursorY = 28;
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: () => true,
    });
    const bottom = container.scrollTop;
    container.dispatchEvent(touchEvent("touchstart", 300));
    container.scrollTop = bottom - 14.3;
    container.dispatchEvent(new Event("scroll"));
    expect(terminal.buffer.active.viewportY).toBe(4999);

    container.dispatchEvent(touchEvent("touchmove", 305));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    const paintedViewportY = terminal.buffer.active.viewportY;
    container.dispatchEvent(touchEvent("touchmove", 322));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(terminal.buffer.active.viewportY).toBe(paintedViewportY);
  });

  it("commits wheel row transitions atomically with xterm viewport changes", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    container.scrollTop = 200;
    terminal.scrollToLine.mockClear();

    const event = new WheelEvent("wheel", { deltaY: -1, cancelable: true });
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(9);
    expect(host.style.top).toBe("180px");

    container.dispatchEvent(new Event("scroll"));

    expect(host.style.top).toBe("180px");

    emitRender();

    expect(host.style.top).toBe("180px");
  });

  it("keeps the short-host vertical origin when review begins", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 550 });
    const { terminal } = createTerminal({ 99: "prompt" });
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: createHistoryProjectionRenderer(),
    });

    const originBeforeReview =
      Number.parseFloat(host.style.top) - terminal.buffer.active.viewportY * 20;
    expect(originBeforeReview).toBe(150);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, cancelable: true }));

    const originAfterReview =
      Number.parseFloat(host.style.top) - terminal.buffer.active.viewportY * 20;
    expect(originAfterReview).toBe(originBeforeReview);
  });

  it("captures one coherent review frame and keeps it frozen across output renders", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, cancelable: true }));
    emitRender();
    const capturesAtReviewEntry = getHistoryProjections(renderProjection, "review").length;
    expect(capturesAtReviewEntry).toBeGreaterThan(0);
    expect(getHistoryProjections(renderProjection, "review").at(-1)).toEqual(
      expect.objectContaining({
        startLine: terminal.buffer.active.viewportY,
        endLine: terminal.buffer.active.viewportY + terminal.rows,
        rowHeight: 20,
      }),
    );

    emitRender();
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(capturesAtReviewEntry);

    controller.refreshReviewSnapshot();
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(
      capturesAtReviewEntry + 1,
    );
    expect(getHistoryProjections(renderProjection, "review").at(-1)).toEqual(
      expect.objectContaining({
        startLine: terminal.buffer.active.viewportY,
        endLine: terminal.buffer.active.viewportY + terminal.rows,
        rowHeight: 20,
      }),
    );

    controller.scrollToBottom("test", { force: true });
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);
  });

  it("refreshes an in-place live row while it remains inside the reviewed frame", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "live status" });
    const renderProjection = createHistoryProjectionRenderer();
    let pendingFrame = false;
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => pendingFrame,
      consumeNewFrame: () => {
        pendingFrame = false;
      },
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, cancelable: true }));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(terminal.buffer.active.baseY + terminal.buffer.active.cursorY).toBeLessThan(
      terminal.buffer.active.viewportY + terminal.rows,
    );
    const capturesAtReviewEntry = getHistoryProjections(renderProjection, "review").length;
    expect(capturesAtReviewEntry).toBeGreaterThan(0);

    // An in-place status repaint is still part of the frame the user can see, so replace the
    // serialized snapshot once after xterm renders it.
    pendingFrame = true;
    emitRender();
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(
      capturesAtReviewEntry + 1,
    );

    // Once output has advanced beyond the frozen viewport, later frames must not leak into it.
    terminal.buffer.active.length += terminal.rows + 1;
    pendingFrame = true;
    emitRender();
    expect(terminal.buffer.active.baseY + terminal.buffer.active.cursorY).toBeGreaterThanOrEqual(
      terminal.buffer.active.viewportY + terminal.rows,
    );
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(
      capturesAtReviewEntry + 1,
    );
  });

  it("keeps the review host and row anchor stable while the live buffer grows", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender, emitScroll } = createTerminal({ 99: "prompt" });
    const renderProjection = createHistoryProjectionRenderer();
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, cancelable: true }));
    expect(getHistoryProjections(renderProjection, "review").at(-1)).toEqual(
      expect.objectContaining({ startLine: 78, endLine: 98, rowHeight: 20 }),
    );
    const capturesAtReviewEntry = getHistoryProjections(renderProjection, "review").length;
    const frozenHostTop = host.style.top;

    terminal.buffer.active.length += 12;
    terminal.buffer.active.viewportY += 12;
    emitScroll();
    emitRender();

    expect(host.style.top).toBe(frozenHostTop);
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(capturesAtReviewEntry);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));

    expect(getHistoryProjections(renderProjection, "review").at(-1)).toEqual(
      expect.objectContaining({ startLine: 77, endLine: 98, rowHeight: 20 }),
    );
    expect(host.style.top).toBe("1560px");
  });

  it("does not refresh the review frame for a container scroll event without vertical movement", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
    const renderProjection = createHistoryProjectionRenderer();
    attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, cancelable: true }));
    emitRender();
    const capturesAtReviewEntry = getHistoryProjections(renderProjection, "review").length;
    expect(capturesAtReviewEntry).toBeGreaterThan(0);

    container.dispatchEvent(new Event("scroll"));
    emitRender();

    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(capturesAtReviewEntry);
  });

  it("syncs native touch scroll to the matching terminal row before committing host position on render", () => {
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
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    container.scrollLeft = 600;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 145;
    container.dispatchEvent(new Event("scroll"));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(7);
    expect(host.style.top).toBe("1600px");

    emitRender();

    expect(host.style.top).toBe("140px");
  });

  it("keeps short-host positioning in one coordinate system during native scroll", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "8px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 3414);
    defineScrollWidth(container, 360);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 600, clientWidth: 336 });
    const { terminal } = createTerminal({ 166: "prompt" });
    terminal.rows = 30;
    terminal.cols = 42;
    terminal.buffer.active.length = 169;
    terminal.buffer.active.viewportY = 130;
    terminal.buffer.active.cursorX = 2;
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
      initialUserHasVerticalScrollIntent: true,
    });

    // host = 30 * 20 = 600, visible = 634 - 8 - 8 = 618, so short-host
    // positioning has an 18px bottom-pin offset. Native scroll must not fall back
    // to raw row alignment (130 * 20 = 2600), or the terminal visibly jumps.
    expect(host.style.top).toBe("2618px");

    container.dispatchEvent(touchEvent("touchstart", 320));
    container.scrollTop = 2604;
    container.dispatchEvent(new Event("scroll"));

    expect(terminal.scrollToLine).not.toHaveBeenCalledWith(129);
    expect(host.style.top).toBe("2618px");
  });

  it("keeps short-host positioning stable when term scroll follows to bottom", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "8px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 16,
    });
    defineScrollWidth(container, 360);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 600, clientWidth: 336 });
    const { terminal, emitScroll } = createTerminal({ 166: "prompt" });
    terminal.rows = 30;
    terminal.cols = 42;
    terminal.buffer.active.length = 143;
    terminal.buffer.active.viewportY = 113;
    terminal.buffer.active.cursorX = 0;
    terminal.buffer.active.cursorY = 29;

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

    expect(host.style.top).toBe("2278px");

    terminal.buffer.active.length = 144;
    terminal.buffer.active.viewportY = 114;
    emitScroll();

    expect(container.scrollTop).toBe(2280);
    expect(host.style.top).toBe("2298px");
  });

  // Vertical intent integration. The set/clear state table lives in
  // pty-vertical-intent-fsm.test.ts; this block only proves controller events and xterm/DOM
  // side effects are wired to that FSM correctly.
  it("preserves browser scroll when xterm scrolls while user is away from bottom", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitScroll } = createTerminal({ 99: "prompt" });
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
    container.scrollTop = 100;
    terminal.buffer.active.viewportY = 7;
    emitScroll();

    expect(container.scrollTop).toBe(100);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5);
    expect(host.style.top).toBe("100px");
  });

  it("keeps the xterm viewport on the reviewed history when new output scrolls the terminal", () => {
    const { container, spacer, host } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitScroll } = createTerminal({ 99: "prompt" });
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
    container.scrollTop = 100;
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
    const { terminal, emitScroll } = createTerminal({ 99: "prompt", 109: "new prompt" });
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

    // A DOM scrollHeight-only drift does not move the semantic live tail.
    expect(container.scrollTop).toBe(1600);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it("follows to bottom on render when a real new frame arrives at bottom", () => {
    const { container, spacer, host } = createDom();
    const consumeNewFrame = vi.fn();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    const { terminal, emitRender } = createTerminal({ 99: "prompt", 109: "new prompt" });
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
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

  it("keeps touch review intent through output after a vertical gesture starts", () => {
    const { container, spacer, host } = createDom();
    const setNewFramesWhileAway = vi.fn();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchmove", 320));
    emitRender();

    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("notifies when a touch gesture becomes vertical terminal review", () => {
    const { container, spacer, host } = createDom();
    const onTouchReviewStart = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    container.dispatchEvent(touchEvent("touchmove", 305));
    expect(onTouchReviewStart).not.toHaveBeenCalled();

    container.dispatchEvent(touchEvent("touchmove", 320));
    container.dispatchEvent(touchEvent("touchmove", 350));
    expect(onTouchReviewStart).toHaveBeenCalledTimes(1);

    container.dispatchEvent(touchEvent("touchend", 350));
    container.dispatchEvent(touchEvent("touchstart", 250));
    container.dispatchEvent(touchEvent("touchmove", 270));
    expect(onTouchReviewStart).toHaveBeenCalledTimes(2);
  });

  it("rejects catastrophic native touch scroll jumps while preserving the intended small review scroll", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchmove", 360));
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(1540);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(77);
    expect(host.style.top).toBe("1600px");
    emitRender();
    expect(host.style.top).toBe("1540px");
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("does not create review intent after a bottom tap without scroll movement", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchend", 300));

    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
  });

  it("keeps sub-threshold touch movement pending without rewriting terminal scroll", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    expect(container.scrollTop).toBe(1600);
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300));
    const move = touchEvent("touchmove", 310);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("pending");
  });

  it("does not let pending output pull a slow native touch scroll back to bottom", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const setNewFramesWhileAway = vi.fn();
    const { terminal, emitRender } = createTerminal({ 99: "live prompt" });
    let hasNewFrame = false;
    const controller = attachPtyScrollController({
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
    expect(container.scrollTop).toBe(1600);
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchmove", 315));
    container.scrollTop = 1594;
    container.dispatchEvent(new Event("scroll"));

    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("pending");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(terminal.buffer.active.viewportY).toBe(79);
    terminal.scrollToLine.mockClear();

    hasNewFrame = true;
    emitRender();

    expect(container.scrollTop).toBe(1594);
    expect(terminal.buffer.active.viewportY).toBe(79);
    expect(terminal.scrollToLine).not.toHaveBeenCalledWith(80);
    expect(hasNewFrame).toBe(true);

    container.dispatchEvent(touchEvent("touchmove", 317));
    container.dispatchEvent(touchEvent("touchend", 317));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1594);
    expect(terminal.buffer.active.viewportY).toBe(79);
    expect(hasNewFrame).toBe(false);
    expect(setNewFramesWhileAway).toHaveBeenCalledWith(true);
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("lets native vertical touch scroll own scrollTop after gesture lock", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    expect(container.scrollTop).toBe(1600);
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300));
    const move = touchEvent("touchmove", 320);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    container.scrollTop = 1580;
    container.dispatchEvent(new Event("scroll"));
    expect(container.scrollTop).toBe(1580);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(79);
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(true);
    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("vertical");
  });

  it("does not pull native vertical touch scroll back to a finger-derived expected position", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 30700);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 1530: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 1533;
    terminal.buffer.active.viewportY = 1476;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
    container.scrollTop = 29568;

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

    container.dispatchEvent(touchEvent("touchstart", 195));
    container.dispatchEvent(touchEvent("touchmove", 398));
    // Chrome may report a native scroll position that lags the idealized
    // finger-distance formula. The controller must not fight that native scroll.
    container.scrollTop = 29503;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(29503);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(1475);
  });

  it("observes same-row native touch scroll without resyncing xterm", () => {
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
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 51580);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 2574: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 2577;
    terminal.buffer.active.viewportY = 2525;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
    container.scrollTop = 50946;
    const onScrollStateChange = vi.fn<(state: PtyScrollState) => void>();

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
      onScrollStateChange,
    });
    terminal.scrollToLine.mockClear();
    onScrollStateChange.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 412));
    container.dispatchEvent(touchEvent("touchmove", 465));
    container.scrollTop = 50892.5703125;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 50890;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(50890);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(host.style.top).toBe("50500px");
    expect(onScrollStateChange).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    queued[0]?.(performance.now());

    expect(onScrollStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 50890, scrollWidth: 2184 }),
    );
  });

  it("does not force same-viewport bottom touch starts to a finger-derived scrollTop", () => {
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
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 43900);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 2190: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 2193;
    terminal.buffer.active.viewportY = 2141;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
    container.scrollTop = 43266;

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

    container.dispatchEvent(touchEvent("touchstart", 312));
    container.scrollTop = 43262.5703125;
    container.dispatchEvent(touchEvent("touchmove", 362));

    expect(container.scrollTop).toBe(43262.5703125);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(host.style.top).toBe("42820px");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("leaves same-viewport native scroll alone while touch is active", () => {
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
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 64940);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 3242: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 3245;
    terminal.buffer.active.viewportY = 3193;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
    container.scrollTop = 64306;

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

    container.dispatchEvent(touchEvent("touchstart", 384));
    container.scrollTop = 64258.28515625;
    container.dispatchEvent(touchEvent("touchmove", 425));

    expect(container.scrollTop).toBe(64258.28515625);

    container.scrollTop = 64251.4296875;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(64251.4296875);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(host.style.top).toBe("63860px");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    queued[0]?.(performance.now());
  });

  it("does not restore to bottom after a real pre-threshold bottom pull", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 101080);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 5049: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 5052;
    terminal.buffer.active.viewportY = 5000;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;

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
    expect(container.scrollTop).toBe(100406);
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 446));
    container.scrollTop = 100398.7109375;
    container.dispatchEvent(touchEvent("touchmove", 458));
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBeCloseTo(100398.7109375);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("keeps reviewing after a slow bottom-start pull even while the cursor stays visible", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 101080);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 5049: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 5052;
    terminal.buffer.active.viewportY = 5000;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
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
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBe(100406);
    onUserVerticalScrollIntentChange.mockClear();
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 478));
    container.scrollTop = 100387.4296875;
    container.dispatchEvent(touchEvent("touchmove", 545));
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 100359.140625;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchend", 572));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(controller.getDebugProbe().verticalIntentTransitionId).toBe("touch.end.not-bottom");
    expect(onUserVerticalScrollIntentChange.mock.calls.map((call) => call[0])).toEqual([true]);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("syncs xterm when native touch scroll crosses to a different row", () => {
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
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    defineScrollHeight(container, 51580);
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal, emitRender } = createTerminal({ 2574: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 2577;
    terminal.buffer.active.viewportY = 2525;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
    container.scrollTop = 50946;
    const onScrollStateChange = vi.fn<(state: PtyScrollState) => void>();

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
      onScrollStateChange,
    });
    terminal.scrollToLine.mockClear();
    onScrollStateChange.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 412));
    container.dispatchEvent(touchEvent("touchmove", 465));
    container.scrollTop = 50892.5703125;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 50480;
    container.dispatchEvent(new Event("scroll"));

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(2524);
    expect(host.style.top).toBe("50500px");
    expect(onScrollStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 50480 }),
    );

    emitRender();

    expect(host.style.top).toBe("50480px");
  });

  it("commits the expected horizontal pan after horizontal touch lock", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 400, clientWidth: 360 });
    defineScrollWidth(container, 1200);
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    expect(container.scrollTop).toBe(1600);
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300, 320));
    const move = touchEvent("touchmove", 302, 200);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollLeft).toBe(120);
    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("horizontal");
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollLeft).toBe(120);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("does not clear horizontal touch intent while the cursor is still visible", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 400, clientWidth: 360 });
    defineScrollWidth(container, 1200);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    terminal.buffer.active.cursorX = 2;

    container.dispatchEvent(touchEvent("touchstart", 300, 320));
    container.dispatchEvent(touchEvent("touchmove", 302, 200));
    container.scrollLeft = 15;
    container.dispatchEvent(new Event("scroll"));

    emitRender();

    expect(container.scrollLeft).toBe(15);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    container.scrollLeft = 26;
    container.dispatchEvent(new Event("scroll"));
    emitRender();

    expect(container.scrollLeft).toBe(26);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);
  });

  it("locks horizontal touch pan on a small mostly-horizontal move", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 400, clientWidth: 360 });
    defineScrollWidth(container, 1200);
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300, 320));
    const move = touchEvent("touchmove", 302, 310);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollLeft).toBe(10);
    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("horizontal");
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollLeft).toBe(10);
  });

  it("keeps ambiguous diagonal touch pending instead of stealing vertical review", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 400, clientWidth: 360 });
    defineScrollWidth(container, 1200);
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    terminal.scrollToLine.mockClear();

    container.dispatchEvent(touchEvent("touchstart", 300, 320));
    const move = touchEvent("touchmove", 318, 304);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollLeft).toBe(0);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
    expect(controller.getDebugProbe().touchScrollGestureMode).toBe("pending");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
  });

  it("keeps bottom tap inert when keyboard padding moves the bottom before touchend", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });
    expect(container.scrollTop).toBe(1600);

    container.dispatchEvent(touchEvent("touchstart", 300));
    defineScrollHeight(container, 2080);
    container.dispatchEvent(touchEvent("touchend", 300));
    controller.scrollToBottom("rawInput");

    // A layout-only DOM range change does not move the semantic live tail.
    expect(container.scrollTop).toBe(1600);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
  });

  it("canonicalizes a non-user keyboard layout shift after a stationary bottom touch", () => {
    const visualViewport = new EventTarget();
    Object.assign(visualViewport, {
      height: 390,
      width: 360,
      offsetTop: 0,
      pageTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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

    container.dispatchEvent(touchEvent("touchstart", 300));
    window.visualViewport?.dispatchEvent(new Event("resize"));
    container.scrollTop = 1200;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchend", 300));

    expect(container.scrollTop).toBe(1600);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(true);
  });

  it("restores semantic bottom when a stationary long-host touch jumps to host top", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 1061: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 1064;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
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
    expect(container.scrollTop).toBe(20646);
    expect(host.style.top).toBe("20240px");

    container.dispatchEvent(touchEvent("touchstart", 550));
    onUserVerticalScrollIntentChange.mockClear();
    container.scrollTop = 20240;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchend", 550));

    expect(container.scrollTop).toBe(20646);
    expect(host.style.top).toBe("20240px");
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
  });

  it("restores a bottom tap when mobile native scroll jumps to the host top", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1080, clientWidth: 2160 });
    const { terminal } = createTerminal({ 5051: "live prompt" });
    terminal.rows = 54;
    terminal.cols = 270;
    terminal.buffer.active.length = 5054;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 51;
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
    expect(container.scrollTop).toBe(100446);
    expect(host.style.top).toBe("100000px");

    container.dispatchEvent(touchEvent("touchstart", 330));
    const move = touchEvent("touchmove", 321);
    container.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(100446);

    container.scrollTop = 100000;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchend", 321));

    expect(container.scrollTop).toBe(100446);
    expect(terminal.buffer.active.viewportY).toBe(5000);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(true);
  });

  it("preserves a host-top-adjacent bare scroll after explicit review ownership", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "50px";
    defineSize(container, { clientHeight: 651, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 58,
    });
    defineScrollWidth(container, 1456);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 720, clientWidth: 1432 });
    const { terminal, emitRender } = createTerminal({ 5033: "review prompt" });
    terminal.rows = 36;
    terminal.cols = 179;
    terminal.buffer.active.length = 5036;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 33;

    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: () => true,
    });
    expect(container.scrollTop).toBe(100087);

    controller.markSelectionAutoscrollIntent("test-owned review");
    container.scrollTop = 99919;
    container.dispatchEvent(new Event("scroll"));
    expect(controller.getDebugProbe().userHasVerticalScrollIntent).toBe(true);
    // Choose the xterm viewport from the physical bottom edge, while the snapshot starts at the
    // first visible row. This keeps the whole 593px visible interval covered without coupling the
    // two row indices.
    expect(host.style.top).toBe("99800px");

    container.dispatchEvent(touchEvent("touchstart", 355));
    container.scrollTop = 99897;
    container.dispatchEvent(new Event("scroll"));
    emitRender();
    expect(host.style.top).toBe("99780px");

    container.dispatchEvent(touchEvent("touchmove", 468));
    terminal.scrollToLine.mockClear();
    container.scrollTop = 99884;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBeCloseTo(99884);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(4988);
  });

  it("does not restore tiny host-top-adjacent deltas at semantic bottom", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });

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
    expect(host.style.top).toBe("1600px");

    container.dispatchEvent(touchEvent("touchstart", 300));
    container.dispatchEvent(touchEvent("touchmove", 309));
    terminal.scrollToLine.mockClear();
    container.scrollTop = 1600;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("keeps following when a stale host-top scroll replay is restored to semantic bottom", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    let scrollHeight = 21320;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal } = createTerminal({ 1061: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 1064;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 49;
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
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBe(20646);

    defineSize(container, { clientHeight: 365 });
    scrollHeight = 21400;
    controller.scrollToBottom("keyboardOffset", { force: true });
    expect(container.scrollTop).toBe(20915);

    container.dispatchEvent(touchEvent("touchstart", 210));
    defineSize(container, { clientHeight: 634 });
    scrollHeight = 21320;
    container.scrollTop = 20240;
    container.dispatchEvent(new Event("scroll"));
    expect(container.scrollTop).toBe(20646);

    onUserVerticalScrollIntentChange.mockClear();
    container.dispatchEvent(touchEvent("touchend", 210));
    controller.relayout();

    expect(container.scrollTop).toBe(20646);
    expect(host.style.top).toBe("20240px");
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
  });

  it("canonicalizes a bare browser layout scroll while following", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "112px";
    defineSize(container, { clientHeight: 347, clientWidth: 360 });
    let scrollHeight = 89860;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    const { terminal, emitRender } = createTerminal({ 4484: "live prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
    terminal.buffer.active.length = 4487;
    terminal.buffer.active.cursorX = 10;
    terminal.buffer.active.cursorY = 49;
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
      onUserVerticalScrollIntentChange,
    });
    expect(container.scrollTop).toBe(89473);

    // Consume the initial programmatic-bottom marker so the next event is an unowned browser
    // layout scroll rather than attach-time settling.
    container.dispatchEvent(new Event("scroll"));
    expect(controller.getDebugProbe().pendingProgrammaticScrollTop).toBeNull();
    onUserVerticalScrollIntentChange.mockClear();

    scrollHeight = 89624;
    container.scrollTop = 89276;
    container.dispatchEvent(new Event("scroll"));

    expect(controller.getDebugProbe().userHasVerticalScrollIntent).toBe(false);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(true);

    scrollHeight = 89860;
    emitRender();

    expect(container.scrollTop).toBe(89473);
    expect(controller.getDebugProbe().userHasVerticalScrollIntent).toBe(false);
  });

  it("preserves user scroll intent when controller is reattached", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    const { terminal } = createTerminal({ 99: "prompt" });
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
    const { terminal } = createTerminal({ 99: "prompt" });
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
    const { terminal } = createTerminal({ 99: "prompt" });
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
    expect(container.scrollLeft).toBe(0);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80);
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);
  });

  it("commits the fractional artifact semantic bottom after a short-host review", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 737, clientWidth: 800 });
    defineScrollHeight(container, 5385);
    defineScrollWidth(container, 800);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 485, clientWidth: 800 });

    // Exact Android artifact geometry: baseY=230 and cellH=485/24 make the semantic
    // live-tail target 4647.916..., while Chrome lands the fractional scrollTop at
    // 4647.619.... ViewportY must remain the row-space value 230 rather than being
    // reconstructed as floor(4647.916... / (485/24)) = 229.
    const semanticBottom = (230 * 485) / 24;
    const chromeLandedBottom = 4647.619140625;
    let landedScrollTop = 0;
    const scrollTopWrites: number[] = [];
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => landedScrollTop,
      set: (value: number) => {
        scrollTopWrites.push(value);
        landedScrollTop = Math.max(0, Math.min(chromeLandedBottom, value));
      },
    });

    const { terminal } = createTerminal({ 252: "live prompt" });
    terminal.rows = 24;
    terminal.buffer.active.length = 254;
    terminal.buffer.active.cursorY = 23;
    const onAtBottomChange = vi.fn();
    const renderProjection = createHistoryProjectionRenderer();
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
      onHistoryProjectionChange: renderProjection,
    });

    expect(container.scrollTop).toBe(chromeLandedBottom);
    expect(terminal.buffer.active.baseY).toBe(230);
    expect(terminal.buffer.active.viewportY).toBe(230);
    container.dispatchEvent(new Event("scroll"));

    // The host is shorter than the browser viewport, so its live frame has a 212px bottom-align
    // origin. Entering review must preserve that origin while moving into history; a later
    // geometry expansion is covered separately by the keyboard reflow regression.
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, cancelable: true }));
    const reviewedViewportY = terminal.buffer.active.viewportY;
    const reviewedHostTop = parseFloat(host.style.top);
    expect(container.scrollTop).toBeLessThan(chromeLandedBottom - 20);
    expect(reviewedViewportY).toBeLessThan(229);
    expect(reviewedHostTop - reviewedViewportY * (485 / 24)).toBeCloseTo(212, 10);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    const lastCapture = getHistoryProjections(renderProjection, "review").at(-1);
    expect(lastCapture).toBeDefined();
    expect(lastCapture?.startLine).toBeLessThan(reviewedViewportY);
    expect((lastCapture?.endLine ?? 0) - (lastCapture?.startLine ?? 0)).toBeGreaterThan(
      terminal.rows,
    );
    const snapshotTop = reviewedHostTop + (lastCapture?.topOffset ?? 0);
    expect(snapshotTop).toBeLessThanOrEqual(container.scrollTop);
    expect(snapshotTop).toBeGreaterThan(container.scrollTop - 485 / 24);

    const writesBeforeForce = scrollTopWrites.length;
    controller.scrollToBottom("backToBottomBtn", { force: true });

    expect(scrollTopWrites[writesBeforeForce]).toBeCloseTo(semanticBottom, 10);
    expect(container.scrollTop).toBe(chromeLandedBottom);
    expect(terminal.buffer.active.viewportY).toBe(230);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);

    // Chrome delivers the scroll event after the fractional write has already landed at the
    // device-pixel maximum. It is still semantic bottom and must not regress viewportY to 229.
    container.dispatchEvent(new Event("scroll"));
    const snapshot = buildPtyScrollDebugSnapshot(controller.getDebugProbe, {
      container,
      spacer,
      host,
      term: terminal,
    });
    expect(container.scrollTop).toBe(chromeLandedBottom);
    expect(terminal.buffer.active.viewportY).toBe(230);
    expect(snapshot.anchor.bottomScrollTop).toBeCloseTo(semanticBottom, 10);
    expect(snapshot.anchor.cursorInViewport).toBe(true);
    expect(snapshot.anchor.atBottom).toBe(true);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it("returns lifecycle resume to the current live tail instead of restoring review pixels", () => {
    const { container, spacer, host } = createDom();
    const onUserVerticalScrollIntentChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    });

    expect(container.scrollTop).toBe(1600);
    controller.scrollToRatio(100 / 1600);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    terminal.scrollToLine.mockClear();
    onUserVerticalScrollIntentChange.mockClear();

    controller.preparePageResumeRestore();
    // A hidden browser may replay any old DOM coordinate. It is not a persisted semantic anchor.
    container.scrollTop = 700;
    container.dispatchEvent(new Event("scroll"));
    controller.restorePageResume();

    expect(container.scrollTop).toBe(1600);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80);
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(false);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
  });

  it("does not let a completed lifecycle resume keep overriding later vertical or horizontal input", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
    terminal.cols = 160;
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
    defineScrollWidth(container, 1600);

    controller.preparePageResumeRestore();
    container.scrollTop = 100;
    container.scrollLeft = 600;
    controller.restorePageResume();
    expect(container.scrollTop).toBe(1600);
    expect(container.scrollLeft).toBe(0);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    const reviewedScrollTop = container.scrollTop;
    expect(reviewedScrollTop).toBeLessThan(1600);
    controller.scrollToXRatio(0.5);
    expect(container.scrollLeft).toBe(400);

    container.dispatchEvent(new Event("scroll"));
    emitRender();
    emitRender();
    expect(container.scrollTop).toBe(reviewedScrollTop);
    expect(container.scrollLeft).toBe(400);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
  });

  it("owns at-bottom state and exposes scrollToBottom", () => {
    const { container, spacer, host } = createDom();
    const onAtBottomChange = vi.fn();
    const { terminal } = createTerminal({ 99: "prompt" });
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

    controller.scrollToRatio(100 / 1600);
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
    const { terminal } = createTerminal({ 99: "prompt" });
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

    controller.scrollToRatio(100 / 1600);
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
    const { terminal } = createTerminal({ 99: "prompt" });
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

  it("releases review and commits semantic bottom at the custom scrollbar endpoint", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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
      onUserVerticalScrollIntentChange,
    });
    controller.scrollToRatio(0.5);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");

    controller.scrollToRatio(1);

    expect(container.scrollTop).toBe(1600);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(host.style.top).toBe("1600px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(onUserVerticalScrollIntentChange).toHaveBeenLastCalledWith(false);
  });

  // Wheel integration around semantic live bottom. Pure "should clear intent?" semantics are
  // FSM coverage; these tests verify controller geometry produces the right bottom signal.
  // 镜像反向: 用户主动向下滚到底, intent 应该释放, output 才能恢复跟随。
  it("releases vertical scroll intent when user wheels down back to bottom", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 300 });
    defineScrollHeight(container, 2000);
    const { terminal } = createTerminal({ 99: "prompt" });
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

  it("commits the exact semantic frame when a review wheel crosses bottom", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "live prompt" });
    terminal.buffer.active.cursorY = 19;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });
    expect(container.scrollTop).toBe(1600);
    expect(terminal.buffer.active.viewportY).toBe(80);

    // The 299px accumulated review delta is one pixel short of 15 complete rows. Mapping
    // 1600px back through that review anchor would therefore stop at viewportY=79, which
    // excludes the cursor on absolute row 99 and leaves review intent stuck at pixel bottom.
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -299, cancelable: true }));
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, cancelable: true }));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(terminal.buffer.active.viewportY).toBe(68);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 10_000, cancelable: true }));

    expect(container.scrollTop).toBe(1600);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(host.style.top).toBe("1600px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);
  });

  it("resumes live output when wheel-down reaches the frozen review boundary", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitScroll, emitRender } = createTerminal({ 99: "initial live tail" });
    terminal.buffer.active.cursorY = 19;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => true,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    expect(container.scrollTop).toBe(1600);
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, cancelable: true }));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1400);

    // The reviewed frame ends at the old 1600px bottom. While it remains frozen, thirty new
    // rows move the live semantic bottom to 2200px. A sequence of ordinary wheel deltas must not
    // be forced to cross that invisible 600px gap in one event.
    terminal.buffer.active.length += 30;
    terminal.buffer.active.viewportY += 30;
    defineScrollHeight(container, 2600);
    emitScroll();
    emitRender();
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1400);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1520);

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(container.scrollTop).toBe(2200);
    expect(terminal.buffer.active.viewportY).toBe(110);
    expect(host.style.top).toBe("2200px");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);
  });

  it("resumes live output when a review touch reaches the frozen review boundary", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitScroll, emitRender } = createTerminal({ 99: "initial live tail" });
    terminal.buffer.active.cursorY = 19;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => true,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    expect(container.scrollTop).toBe(1600);
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, cancelable: true }));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1400);

    terminal.buffer.active.length += 30;
    terminal.buffer.active.viewportY += 30;
    defineScrollHeight(container, 2600);
    emitScroll();
    emitRender();
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1400);

    container.dispatchEvent(touchEvent("touchstart", 320));
    const move = touchEvent("touchmove", 100);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(container.scrollTop).toBe(2200);
    expect(terminal.buffer.active.viewportY).toBe(110);
    expect(host.style.top).toBe("2200px");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);

    container.dispatchEvent(touchEvent("touchend", 100));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
  });

  it("resumes live output when post-touch inertia reaches the frozen review boundary", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitScroll, emitRender } = createTerminal({ 99: "initial live tail" });
    terminal.buffer.active.cursorY = 19;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => true,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, cancelable: true }));
    terminal.buffer.active.length += 30;
    terminal.buffer.active.viewportY += 30;
    defineScrollHeight(container, 2600);
    emitScroll();
    emitRender();
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1400);

    container.dispatchEvent(touchEvent("touchstart", 320));
    container.dispatchEvent(touchEvent("touchmove", 280));
    container.scrollTop = 1440;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchend", 280));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");

    // Android keeps delivering compositor-owned scroll frames after touchend. The old path
    // stopped at the frozen row, then classified the overshoot as a harmless same-row update,
    // leaving the DOM viewport below the serialized review projection.
    container.scrollTop = 1600;
    container.dispatchEvent(new Event("scroll"));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(container.scrollTop).toBe(2200);
    expect(terminal.buffer.active.viewportY).toBe(110);
    expect(host.style.top).toBe("2200px");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);
  });

  it("keeps review ownership when a touch first locks toward history", () => {
    const { container, spacer, host } = createDom();
    const { terminal, emitScroll, emitRender } = createTerminal({ 99: "initial live tail" });
    terminal.buffer.active.cursorY = 19;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => true,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, cancelable: true }));
    terminal.buffer.active.length += 30;
    terminal.buffer.active.viewportY += 30;
    defineScrollHeight(container, 2600);
    emitScroll();
    emitRender();
    expect(container.scrollTop).toBe(1400);

    // The first locked direction owns the gesture. A later Android geometry/clamp frame must not
    // reinterpret a finger-down (toward-history) gesture as an instruction to reveal live output.
    container.dispatchEvent(touchEvent("touchstart", 200));
    container.dispatchEvent(touchEvent("touchmove", 240));
    container.scrollTop = 1600;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 1700;
    container.dispatchEvent(new Event("scroll"));

    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(container.scrollTop).toBe(1600);
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(0);

    container.dispatchEvent(touchEvent("touchend", 240));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
  });

  it("closes stale review state on a downward wheel already clamped at semantic bottom", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "live prompt" });
    terminal.buffer.active.cursorY = 19;
    terminal.buffer.active.viewportY = 79;
    container.scrollTop = 1600;
    host.style.top = "1580px";
    const renderProjection = createHistoryProjectionRenderer();
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
      onHistoryProjectionChange: renderProjection,
    });
    controller.refreshReviewSnapshot();
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(getHistoryProjections(renderProjection, "review")).toContainEqual(
      expect.objectContaining({
        startLine: 80,
        endLine: terminal.buffer.active.length - 1,
        rowHeight: 20,
        topOffset: 20,
      }),
    );

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));

    expect(container.scrollTop).toBe(1600);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(host.style.top).toBe("1600px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(1);
  });

  it("does not wheel down past semantic bottom in longHost mode", () => {
    const { container, spacer, host } = createDom();
    defineSize(container, { clientHeight: 300 });
    defineScrollHeight(container, 2000);
    const { terminal } = createTerminal({ 87: "prompt" });
    // baseY=80 and cursorY=7 put the live prompt at absolute row 87. Semantic bottom
    // bottom-aligns that row at 1460, below the DOM geometric maximum of 1700. Wheel-down
    // at that anchor must not push the browser
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
    expect(container.scrollTop).toBe(1460);
    onUserVerticalScrollIntentChange.mockClear();

    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));

    expect(container.scrollTop).toBe(1460);
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalledWith(true);
  });

  it("clamps native touch scroll past semantic bottom before pending output can snap back", () => {
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
    expect(container.scrollTop).toBeCloseTo(4726);

    container.dispatchEvent(touchEvent("touchstart", 320));
    onUserVerticalScrollIntentChange.mockClear();
    container.scrollTop = 5166;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBeCloseTo(4726);
    expect(terminal.buffer.active.viewportY).toBe(236);

    container.dispatchEvent(touchEvent("touchend", 280));
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();

    hasNewFrame = true;
    emitRender();

    expect(container.scrollTop).toBeCloseTo(4726);
    expect(setNewFramesWhileAway).not.toHaveBeenCalledWith(true);
  });

  it("does not expose native vertical scroll range below semantic bottom", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 634, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    defineScrollWidth(container, 2184);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 1080, clientWidth: 2160 });
    const { terminal } = createTerminal({ 168: "live prompt" });
    terminal.rows = 54;
    terminal.cols = 270;
    terminal.buffer.active.length = 209;
    terminal.buffer.active.cursorY = 13;

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

    expect(container.scrollTop).toBe(2786);
    expect(spacer.style.overflow).toBe("hidden");
    expect(container.scrollHeight - container.clientHeight).toBe(2786);
  });

  it("keeps semantic-bottom touchmove passive at the native boundary", () => {
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
    const onTouchReviewStart = vi.fn();

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
      onTouchReviewStart,
    });
    expect(container.scrollTop).toBeCloseTo(7306);

    container.dispatchEvent(touchEvent("touchstart", 320));
    onUserVerticalScrollIntentChange.mockClear();
    const move = touchEvent("touchmove", 280);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(onTouchReviewStart).not.toHaveBeenCalled();

    container.dispatchEvent(touchEvent("touchend", 280));
    expect(onUserVerticalScrollIntentChange).not.toHaveBeenCalled();
  });

  it("suppresses PTY input focus when touch movement starts reviewing history", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "live prompt" });
    const onUserVerticalScrollIntentChange = vi.fn();
    const onTouchReviewStart = vi.fn();

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
      onTouchReviewStart,
    });
    expect(container.scrollTop).toBe(1600);

    container.dispatchEvent(touchEvent("touchstart", 320));
    const move = touchEvent("touchmove", 360);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(onUserVerticalScrollIntentChange).toHaveBeenCalledWith(true);
    expect(onTouchReviewStart).toHaveBeenCalledTimes(1);
  });

  it("snaps to semantic bottom when native scroll crosses into the bottom gap", () => {
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
    expect(container.scrollTop).toBeCloseTo(8326);

    container.scrollTop = 8318;
    container.dispatchEvent(touchEvent("touchstart", 320));
    const move = touchEvent("touchmove", 300);
    container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(8318);

    container.scrollTop = 8353;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBeCloseTo(8326);
  });

  it("re-aligns semantic live tail when keyboard close changes a long host into a short host", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 300, clientWidth: 360 });
    defineScrollHeight(container, 2000);
    defineScrollWidth(container, 800);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 400, clientWidth: 800 });
    const { terminal } = createTerminal({ 87: "live prompt" });
    terminal.buffer.active.cursorY = 7;
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
    // Keyboard-open visibleContentHeight=260 < hostHeight=400. Absolute live row 87
    // is bottom-aligned and preceding history fills the narrow viewport.
    expect(container.scrollTop).toBe(1500);
    expect(terminal.buffer.active.viewportY).toBe(75);

    // Keyboard close releases enough height to make visibleContentHeight=594 > hostHeight.
    // The live buffer and server-owned row count stay unchanged.
    defineSize(container, { clientHeight: 634 });
    controller.relayout();

    // Unified semantic anchoring crosses the long/short boundary without falling back to
    // geometric buffer bottom: seven more history rows fill the released area.
    expect(container.scrollTop).toBe(1360);
    expect(terminal.buffer.active.viewportY).toBe(68);
    const visibleBottom = container.scrollTop + container.clientHeight - 32;
    const shortHostOffset = container.clientHeight - 8 - 32 - terminal.rows * 20;
    const cursorBottom = 8 + shortHostOffset + (terminal.buffer.active.baseY + 7 + 1) * 20;
    expect(cursorBottom).toBe(visibleBottom);
  });

  it("keeps following when a keyboard-close native clamp lands before the long-to-short relayout", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "50px";
    defineSize(container, { clientHeight: 298, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 58,
    });
    defineScrollWidth(container, 1600);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 500, clientWidth: 1600 });
    const { terminal } = createTerminal({ 226: "live prompt" });
    terminal.rows = 25;
    terminal.buffer.active.length = 227;
    terminal.buffer.active.cursorY = 24;

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
    expect(container.scrollTop).toBe(4300);
    expect(terminal.buffer.active.baseY).toBe(202);
    expect(terminal.buffer.active.viewportY).toBe(202);

    // On real Android Chrome the layout viewport expands first. Before ResizeObserver can
    // relayout the PTY, the browser clamps the old native scroll range and emits a bare scroll.
    defineSize(container, { clientHeight: 655 });
    container.scrollTop = 3746.857;
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(4040);
    expect(terminal.buffer.active.viewportY).toBe(202);
    expect(host.style.top).toBe("4137px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");

    // A later ResizeObserver relayout must preserve the same committed semantic frame.
    controller.relayout();

    // No user-owned vertical input happened, so the clamp belongs to the geometry transition:
    // commit the new semantic frame atomically instead of capturing it as history review.
    expect(container.scrollTop).toBe(4040);
    expect(container.scrollHeight).toBe(4695);
    expect(terminal.buffer.active.viewportY).toBe(202);
    expect(host.style.top).toBe("4137px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
  });

  it("reprojects the reviewed logical rows when keyboard close crosses the long/short boundary", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    defineSize(container, { clientHeight: 300, clientWidth: 360 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    defineScrollWidth(container, 800);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 400, clientWidth: 800 });
    const { terminal } = createTerminal({ 87: "live prompt" });
    terminal.buffer.active.cursorY = 7;

    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });
    expect(container.scrollTop).toBe(1500);
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, cancelable: true }));
    expect(container.scrollTop).toBe(1450);
    expect(terminal.buffer.active.viewportY).toBe(66);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");

    defineSize(container, { clientHeight: 634 });
    controller.relayout();

    // The old model preserved scrollTop=1450 even though only rows through 87 were frozen. Clamp
    // the logical visible top so the frozen snapshot covers the expanded 594px viewport. The
    // xterm viewport remains separately bottom-aligned to that visible interval.
    expect(spacer.style.height).toBe("1954px");
    expect(container.scrollTop).toBeCloseTo(1166);
    expect(terminal.buffer.active.viewportY).toBe(68);
    expect(host.style.top).toBe("1360px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    const closedCapture = getHistoryProjections(renderProjection, "review").at(-1);
    expect(closedCapture).toEqual({
      kind: "review",
      startLine: 58,
      endLine: 87,
      rowHeight: 20,
      topOffset: -200,
    });
    const reviewTop = parseFloat(host.style.top) - 200 - container.scrollTop;
    const reviewBottom = reviewTop + 30 * 20;
    expect(reviewTop).toBeGreaterThanOrEqual(-20);
    expect(reviewTop).toBeLessThanOrEqual(0);
    expect(reviewBottom).toBeGreaterThanOrEqual(594);

    // Subsequent review input remains row-continuous from the reprojected anchor.
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, cancelable: true }));
    expect(container.scrollTop).toBeCloseTo(1146);
    expect(terminal.buffer.active.viewportY).toBe(67);
    expect(host.style.top).toBe("1340px");
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(getHistoryProjectionClearCount(renderProjection)).toBe(0);

    controller.scrollToBottom("backToBottomBtn", { force: true });

    expect(container.scrollTop).toBe(1360);
    expect(terminal.buffer.active.viewportY).toBe(68);
    expect(controller.getDebugProbe().userHasVerticalScrollIntent).toBe(false);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("following");
  });

  it("reflows a touch review across keyboard close without exposing the short-host gap", () => {
    const { container, spacer, host } = createDom();
    container.style.paddingTop = "8px";
    container.style.paddingBottom = "32px";
    // Keep the open-keyboard content viewport at the real 476px without relying on the test
    // DOM's stale getComputedStyle cache when inline padding changes in the same task.
    defineSize(container, { clientHeight: 516, clientWidth: 411 });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => (parseFloat(spacer.style.height || "0") || 0) + 40,
    });
    defineScrollWidth(container, 792);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    defineSize(screen, { clientHeight: 476, clientWidth: 768 });
    const { terminal, emitRender, emitScroll } = createTerminal({ 226: "live prompt" });
    terminal.rows = 25;
    terminal.cols = 80;
    terminal.buffer.active.length = 227;
    terminal.buffer.active.cursorY = 24;
    const renderProjection = createHistoryProjectionRenderer();
    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term: terminal,
      hasNewFrame: () => false,
      consumeNewFrame: vi.fn(),
      hasNewFramesWhileAway: () => false,
      setNewFramesWhileAway: vi.fn(),
      onHistoryProjectionChange: renderProjection,
    });
    expect(container.scrollTop).toBeCloseTo(3846.08);
    expect(terminal.buffer.active.viewportY).toBe(202);

    container.dispatchEvent(touchEvent("touchstart", 600));
    container.scrollTop = 3561.524;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(touchEvent("touchmove", 900));
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");

    defineSize(container, { clientHeight: 737 });
    controller.relayout();

    const cellH = 476 / 25;
    const expectedSnapshotStart = Math.floor(3561.524 / cellH);
    const expectedViewportY = 199;
    expect(expectedSnapshotStart).toBe(187);
    expect(controller.getDebugProbe().verticalIntentMode).toBe("reviewing");
    expect(controller.getDebugProbe().verticalIntentSource).toBe("touch");
    expect(terminal.buffer.active.viewportY).toBe(expectedViewportY);
    expect(container.scrollTop).toBeCloseTo(3561.524);
    expect(parseFloat(host.style.top)).toBeCloseTo(expectedViewportY * cellH);
    const snapshotTop =
      parseFloat(host.style.top) + (expectedSnapshotStart - expectedViewportY) * cellH;
    expect(snapshotTop - container.scrollTop).toBeGreaterThanOrEqual(-cellH);
    expect(snapshotTop - container.scrollTop).toBeLessThanOrEqual(0);
    expect(getHistoryProjections(renderProjection, "review").at(-1)).toEqual(
      expect.objectContaining({
        startLine: expectedSnapshotStart,
        endLine: expectedSnapshotStart + 37,
        rowHeight: cellH,
        topOffset: (expectedSnapshotStart - expectedViewportY) * cellH,
      }),
    );

    // A final sub-row inertia step can cross the serialized snapshot's first-row boundary while
    // the fixed-size xterm viewport remains unchanged. Flush that range change during the scroll
    // event; do not leave it pending for the next live-output render.
    const capturesBeforeInertia = getHistoryProjections(renderProjection, "review").length;
    container.scrollTop = 3559.524;
    container.dispatchEvent(new Event("scroll"));
    expect(terminal.buffer.active.viewportY).toBe(expectedViewportY);
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(
      capturesBeforeInertia + 1,
    );
    expect(getHistoryProjections(renderProjection, "review").at(-1)?.startLine).toBe(
      expectedSnapshotStart - 1,
    );

    const capturesAfterInertia = getHistoryProjections(renderProjection, "review").length;
    terminal.buffer.active.length += 1;
    emitScroll();
    emitRender();
    expect(getHistoryProjections(renderProjection, "review")).toHaveLength(capturesAfterInertia);
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
    expect(container.scrollTop).toBeCloseTo(4226);

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
    const { terminal } = createTerminal({ 99: "prompt" });
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
  it("starts horizontal cursor following within one tab stop of the right edge", () => {
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    defineSize(container, { clientHeight: 347, clientWidth: 360 });
    defineSize(screen, { clientHeight: 400, clientWidth: 800 });
    defineScrollWidth(container, 1_600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    // cellW=10 and the right margin is 8 cells, so [280, 360] is the follow zone.
    terminal.buffer.active.cursorX = 27;
    emitRender();
    expect(container.scrollLeft).toBe(0);

    terminal.buffer.active.cursorX = 28;
    emitRender();
    expect(container.scrollLeft).toBe(100);
  });

  it("auto-scrolls horizontally to center the cursor when it leaves the viewport", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

  it("keeps horizontal cursor following after a small browser scrollLeft nudge while typing", () => {
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    defineSize(container, { clientHeight: 347, clientWidth: 360 });
    defineSize(screen, { clientHeight: 1040, clientWidth: 2160 });
    defineScrollWidth(container, 2184);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
    terminal.rows = 52;
    terminal.cols = 270;
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

    // Mobile browsers can nudge the scroll container horizontally while focusing the hidden
    // textarea / soft keyboard. That is not the user reviewing horizontally and must not
    // suppress followCursorX.
    container.scrollLeft = 28;
    container.dispatchEvent(new Event("scroll"));

    terminal.buffer.active.cursorX = 50; // cursorPxX = 400, viewport [28, 388] -> just out of view
    emitRender();

    // Keep the cursor near the center: 400 - 360 / 2 = 220.
    expect(container.scrollLeft).toBe(220);
  });

  it("treats a large unmarked native horizontal scroll as user review intent", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    container.scrollLeft = 500;
    container.dispatchEvent(new Event("scroll"));

    terminal.buffer.active.cursorX = 5; // cursorPxX = 50, viewport [500, 1300] -> left of view
    emitRender();

    expect(container.scrollLeft).toBe(500);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);
  });

  it("clears stale horizontal intent when terminal content no longer overflows", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    container.scrollLeft = 500;
    container.dispatchEvent(new Event("scroll"));
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    defineScrollWidth(container, 800);
    emitRender();

    expect(container.scrollLeft).toBe(0);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(false);
    expect(controller.getDebugProbe().lastSeenScrollLeft).toBe(0);
  });

  it("does not adjust horizontal scroll when the cursor is already in view", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

  it("holds the line-start viewport after enter until the new cursor becomes visible", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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

    terminal.buffer.active.cursorX = 120;
    emitRender();
    expect(container.scrollLeft).toBe(800);

    controller.resetHorizontalScroll("rawInputEnter", { holdUntilCursorVisible: true });

    expect(container.scrollLeft).toBe(0);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    emitRender();
    expect(container.scrollLeft).toBe(0);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(true);

    terminal.buffer.active.cursorX = 2;
    emitRender();
    expect(container.scrollLeft).toBe(0);
    expect(controller.getDebugProbe().userHasHorizontalScrollIntent).toBe(false);
  });

  // 光标贴最右端时, target 会超过 maxScrollLeft, 必须 clamp 否则 scrollLeft 越界。
  it("clamps horizontal auto-scroll to the rightmost reachable scroll position", () => {
    const { container, spacer, host } = createDom();
    defineScrollWidth(container, 1600);
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    const { terminal, emitRender } = createTerminal({ 99: "prompt" });
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
    const { terminal } = createTerminal({ 99: "prompt" });
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
    // Default baseY=80 and cursorY=0: live-screen fixtures use absolute buffer rows.
    const { terminal } = createTerminal({ 80: "prompt" });
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

    expect(spacer.style.height).toBe("2430px");
    expect(host.style.height).toBe("600px");
    // Semantic bottom bottom-aligns the live cursor row (absolute row 80), so preceding
    // history fills the viewport and the 19 trailing empty server-owned rows stay below it.
    expect(container.scrollTop).toBeCloseTo(2030, 8);
    expect(terminal.buffer.active.viewportY).toBe(67);
    expect(host.style.top).toBe("2010px");
  });

  it("relayout preserves xterm viewport when user is away from bottom", () => {
    const { container, spacer, host } = createDom();
    // Default baseY=80 and cursorY=0: row 19 would be historical, not live-screen content.
    const { terminal } = createTerminal({ 80: "prompt" });
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

    expect(spacer.style.height).toBe("2430px");
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
    // Cold-start buffer has baseY=0, so absolute row 19 is the actual live-screen tail.
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
    // 移动端 production blank-render 候选成因之一: xterm screen 在某帧 measure 不到尺寸
    // (xterm-screen 暂时 0 高 / 还没 attach), getDims 返回 cellH=0。这帧用户若发生滚动,
    // syncContainerScroll 早返回不动 host, host.style.top 卡在上一次有效值上, viewportY
    // 也没跟着 scrollTop 走。下一次 cellH 恢复到正常 (onRender / relayout 收到通知) 时
    // 必须把这次 stale 的 scroll 补上,否则 host 永远停在旧位置——视觉上就是上半截全黑。
    const { container, spacer, host, xterm } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const { terminal } = createTerminal({ 99: "prompt" });

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
    ctrl.scrollToRatio(200 / 1600);
    expect(host.style.top).toBe("200px");

    // 模拟"xterm screen 不可测"的瞬间: xterm-screen clientHeight 跌成 0 → cellH=0
    defineSize(screen, { clientHeight: 0, clientWidth: 0 });
    ctrl.scrollToRatio(600 / 1600);
    // 此时 syncContainerScroll 早返回, host.top 滞留在 stale 值 (=200px) ——这是 bug 的种子。
    expect(host.style.top).toBe("200px");

    // 测量恢复到正常。
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
    const { terminal } = createTerminal({ 99: "prompt" });

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

    ctrl.scrollToRatio(600 / 1600);
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(true);
  });

  it("treats term.cols=0 as cellH=0 and queues retry", () => {
    // measureXtermCellSize 另一条 null 路径: term.cols<=0 || term.rows<=0。
    // 移动端键盘 show/hide 时 container 短暂被压扁, xterm 内部 reflow 可能让 cols 临时为 0。
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    ctrl.scrollToRatio(600 / 1600);
    expect(ctrl.getDebugProbe().pendingContainerSyncRetry).toBe(true);
  });

  it("clears pendingContainerSyncRetry when scrollToBottom takes over the scroll position", () => {
    // scrollToBottom 重写 scrollTop 到底, 上一次 cellH=0 漏掉的"按 user scroll 重对齐"语义就此失效。
    // flag 留 true 不破坏正确性 (再 sync 一遍是 no-op), 但语义不真——审计中应当显式 reset。
    const { container, spacer, host } = createDom();
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const { terminal } = createTerminal({ 99: "prompt" });

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
    ctrl.scrollToRatio(600 / 1600);
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
    const { terminal } = createTerminal({ 99: "prompt" });

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
  //   - syncing.internal: 所有 frame commit 都只围住 term.scrollToLine 的同步回调；host 先写、
  //     container 后写，但 native container scroll 仍保留自己的事件归属。try/finally 保证复位。
  //   - syncing.external: 仅在 onTermScroll 整段 try/finally 围住, finally 里 restore。
  // 模拟 scrollToLine throw 的回归测试在 jsdom 下被作为 unhandled error 上报,污染下一个 test。
  // 这条 invariant 改由静态审查 + cellH 恢复测试一起兜——前者保证 syncing 不卡, 后者保证 host 不卡。

  it("only observes the scroll container (not host) to avoid feedback loop", () => {
    const { container, spacer, host } = createDom();
    const { terminal } = createTerminal({ 99: "prompt" });
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
    const { terminal } = createTerminal({ 99: "prompt" });

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
    const { terminal, disposeScroll, disposeRender } = createTerminal({ 99: "prompt" });
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
  // 之后即空), 纯几何贴底反而显示空白把真内容推出视窗 → 用 semantic live tail 锚定。
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

    it("bottom-aligns the semantic live tail on entry instead of trailing empty rows", () => {
      const params = setupTallHost({ cursorY: 0 });
      attach(params);
      // Empty test lines make cursorY=0 the semantic tail. Its bottom is 17080px, so a
      // 200px viewport starts at 16880 and pulls nine rows of history above the cursor in.
      expect(params.container.scrollTop).toBe(16880);
      expect(params.terminal.buffer.active.viewportY).toBe(844);
    });

    it("bottom-aligns a mid-host cursor when it is the semantic live tail", () => {
      const params = setupTallHost({ cursorY: 25 });
      attach(params);
      // cursorBufferRow=878 ends at 17580px, hence semantic bottom is 17580-200=17380.
      expect(params.container.scrollTop).toBe(17380);
    });

    it("first onRender after entry leaves scrollTop alone when cursor row is unchanged", () => {
      const params = setupTallHost({ cursorY: 25 });
      attach(params);
      expect(params.container.scrollTop).toBe(17380);

      // focus 切换 / theme 重绘 类的"无变动 onRender"不能掀构图。followCursorY 仅在光标行
      // 真的变了那一帧介入 (prevCursorBufferRow guard)。
      params.emitRender();
      expect(params.container.scrollTop).toBe(17380);
    });

    it("preserves the in-host scroll offset when relayout races with first review scroll", () => {
      const params = setupTallHost({ cursorY: 25 });
      const ctrl = attach(params);
      expect(params.container.scrollTop).toBe(17380);

      params.container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));
      expect(params.container.scrollTop).toBe(17379);

      ctrl.relayout();

      expect(params.terminal.buffer.active.viewportY).toBe(853);
      expect(params.container.scrollTop).toBe(17379);
    });

    it("traces same-row followCursorY skips with zero cursor delta", () => {
      window.localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
      const params = setupTallHost({ cursorY: 25 });
      attach(params);
      (
        window as unknown as { __devAnywherePtyScrollTrace?: unknown[] }
      ).__devAnywherePtyScrollTrace = [];

      params.emitRender();

      const events =
        (window as unknown as { __devAnywherePtyScrollTrace?: Array<Record<string, unknown>> })
          .__devAnywherePtyScrollTrace ?? [];
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "followCursorY:skip[same-row]",
            cursorDeltaRows: 0,
            scrollDeltaToAnchor: 0,
          }),
        ]),
      );
    });

    it("traces raw input follow scheduling and fire events", () => {
      window.localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
      const params = setupTallHost({ cursorY: 25 });
      const ctrl = attach(params);
      (
        window as unknown as { __devAnywherePtyScrollTrace?: unknown[] }
      ).__devAnywherePtyScrollTrace = [];

      ctrl.traceRawInputFollowScheduled("rawInput");
      ctrl.traceRawInputFollowFire();

      const events =
        (window as unknown as { __devAnywherePtyScrollTrace?: Array<Record<string, unknown>> })
          .__devAnywherePtyScrollTrace ?? [];
      expect(events.map((event) => event.event)).toEqual([
        "rawInputFollow:scheduled[rawInput]",
        "rawInputFollow:fire",
      ]);
    });

    it("syncs bottom viewport and host before followCursorY scrolls to an escaped cursor", () => {
      const params = setupTallHost({ cursorY: 0 });
      attach(params);
      // 进入: live tail row 853 的底边 17080 与可视区底边对齐。
      expect(params.container.scrollTop).toBe(16880);
      expect(params.terminal.buffer.active.viewportY).toBe(844);

      const syncObservations: Array<{ ydisp: number; scrollTop: number; hostTop: string }> = [];
      params.terminal.scrollToLine.mockClear();
      params.terminal.scrollToLine.mockImplementation((ydisp: number) => {
        syncObservations.push({
          ydisp,
          scrollTop: params.container.scrollTop,
          hostTop: params.host.style.top,
        });
        params.terminal.buffer.active.viewportY = ydisp;
      });

      // Current xterm viewport is [844, 895]. Absolute cursor row 904 escapes it;
      // follow must first render bottomViewportY=853 and position that host, then move DOM.
      params.terminal.buffer.active.cursorY = 51;
      params.emitRender();

      expect(syncObservations).toEqual([{ ydisp: 853, scrollTop: 16880, hostTop: "17060px" }]);
      expect(params.terminal.buffer.active.viewportY).toBe(853);
      expect(params.host.style.top).toBe("17060px");
      expect(params.container.scrollTop).toBe(17900);
    });

    it("reports atBottom=true only at the semantic anchor with the cursor visible", () => {
      const params = setupTallHost({ cursorY: 25 });
      const onAtBottomChange = vi.fn();
      attach(params, { onAtBottomChange });
      // scrollTop=17380 离几何底 17900 还有距离, 但它正好是 semantic live bottom，
      // 且 cursor 可见，所以 BackToBottom 不该亮。
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
