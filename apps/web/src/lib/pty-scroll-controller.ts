import type { Terminal } from "@xterm/xterm";
import { computePtyHostLayout, computeScrollTarget, ydispToScrollTop } from "./pty-scroll";
import { appendPtyScrollTrace, isPtyScrollTraceEnabled } from "./pty-scroll-trace";
import type { PtyDebugSnapshot } from "./pty-debug-snapshot";

interface PtyScrollControllerOptions {
  container: HTMLDivElement;
  spacer: HTMLDivElement;
  host: HTMLDivElement;
  term: Terminal;
  hasNewFrame: () => boolean;
  consumeNewFrame: () => void;
  hasNewFramesWhileAway: () => boolean;
  setNewFramesWhileAway: (value: boolean) => void;
  onAtBottomChange?: (value: boolean) => void;
  onScrollStateChange?: (state: PtyScrollState) => void;
  initialUserHasVerticalScrollIntent?: boolean;
  onUserVerticalScrollIntentChange?: (value: boolean) => void;
  onTouchReviewStart?: () => void;
  atBottomThreshold?: number;
}

interface PtyScrollController {
  dispose: () => void;
  relayout: () => void;
  scrollToBottom: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  getDebugSnapshot: () => Omit<PtyDebugSnapshot, "frame">;
}

export interface PtyScrollState {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  scrollable: boolean;
  horizontalScrollable: boolean;
}

type PendingFrameResult = "none" | "followed" | "marked";

export function attachPtyScrollController(
  options: PtyScrollControllerOptions,
): PtyScrollController {
  const {
    container,
    spacer,
    host,
    term,
    hasNewFrame,
    consumeNewFrame,
    hasNewFramesWhileAway,
    setNewFramesWhileAway,
    onAtBottomChange,
    onScrollStateChange,
    initialUserHasVerticalScrollIntent = false,
    onUserVerticalScrollIntentChange,
    onTouchReviewStart,
    atBottomThreshold = 8,
  } = options;

  const getDims = (): { cellH: number; cellW: number } => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || term.rows === 0 || term.cols === 0) return { cellH: 0, cellW: 0 };
    return {
      cellH: screen.clientHeight / term.rows,
      cellW: screen.clientWidth / term.cols,
    };
  };

  const getVerticalInsets = (): { paddingTop: number; paddingBottom: number } => {
    const style = getComputedStyle(container);
    const parsePx = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      paddingTop: parsePx(style.paddingTop),
      paddingBottom: parsePx(style.paddingBottom),
    };
  };

  const syncing = { external: false, internal: false };
  let lastAtBottom: boolean | null = null;
  let lastScrollStateKey = "";
  let userHasVerticalScrollIntent = initialUserHasVerticalScrollIntent;
  let pendingProgrammaticScrollTop: number | null = null;
  let touchScrollActive = false;
  let touchStartY: number | null = null;
  let touchReviewNotified = false;
  let lastSpacerUpdateAt: number | null = null;

  const setUserHasVerticalScrollIntent = (value: boolean): void => {
    if (userHasVerticalScrollIntent === value) return;
    userHasVerticalScrollIntent = value;
    onUserVerticalScrollIntentChange?.(value);
  };

  const getScrollState = (): PtyScrollState => ({
    scrollTop: container.scrollTop,
    scrollLeft: container.scrollLeft,
    scrollHeight: container.scrollHeight,
    scrollWidth: container.scrollWidth,
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth,
    scrollable: container.scrollHeight > container.clientHeight + atBottomThreshold,
    horizontalScrollable: container.scrollWidth > container.clientWidth + atBottomThreshold,
  });

  const notifyScrollState = (): void => {
    if (!onScrollStateChange) return;
    const state = getScrollState();
    const key = [
      state.scrollTop,
      state.scrollLeft,
      state.scrollHeight,
      state.scrollWidth,
      state.clientHeight,
      state.clientWidth,
      state.scrollable,
      state.horizontalScrollable,
    ].join(":");
    if (key === lastScrollStateKey) return;
    lastScrollStateKey = key;
    onScrollStateChange(state);
  };

  const computeIsAtBottom = (): boolean =>
    container.scrollTop + container.clientHeight >= container.scrollHeight - atBottomThreshold;

  const notifyAtBottom = (): void => {
    const next = computeIsAtBottom();
    if (next && !touchScrollActive) setUserHasVerticalScrollIntent(false);
    if (lastAtBottom === next) return;
    lastAtBottom = next;
    onAtBottomChange?.(next);
  };

  const notifyScroll = (): void => {
    notifyAtBottom();
    notifyScrollState();
  };

  const applySubpixel = (px: number): void => {
    const xtermRoot = host.querySelector<HTMLElement>(".xterm");
    if (!xtermRoot) return;
    xtermRoot.style.transform = px !== 0 ? `translate3d(0,${-px}px,0)` : "";
  };

  const now = (): number =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const trace = (event: string, extra: { ydisp?: number } = {}): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const containerRect = container.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    appendPtyScrollTrace({
      t: now(),
      event,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      innerHeight: window.innerHeight,
      visualViewportHeight: visualViewport?.height,
      visualViewportOffsetTop: visualViewport?.offsetTop,
      containerTop: containerRect.top,
      containerBottom: containerRect.bottom,
      hostRectTop: hostRect.top,
      hostRectBottom: hostRect.bottom,
      viewportY: term.buffer.active.viewportY,
      bufferLength: term.buffer.active.length,
      hostTop: host.style.top,
      focus:
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.tagName ??
        null,
      atBottom: computeIsAtBottom(),
      touchActive: touchScrollActive,
      userIntent: userHasVerticalScrollIntent,
      ...extra,
    });
  };

  const positionHostAt = (ydisp: number, cellH: number, visibleContentHeight?: number): void => {
    if (cellH <= 0) return;
    const hostHeight = term.rows * cellH;
    const verticalOffset =
      visibleContentHeight !== undefined && hostHeight < visibleContentHeight
        ? visibleContentHeight - hostHeight
        : 0;
    host.style.position = "absolute";
    host.style.left = "0px";
    host.style.top = `${Math.max(0, ydisp * cellH + verticalOffset)}px`;
    applySubpixel(0);
    trace("host-position", { ydisp });
  };

  const scrollToBottom = (): void => {
    trace("scroll-to-bottom:start");
    setUserHasVerticalScrollIntent(false);
    const maxYdisp = Math.max(0, term.buffer.active.length - term.rows);
    syncing.internal = true;
    try {
      term.scrollToLine(maxYdisp);
    } finally {
      syncing.internal = false;
    }
    applySubpixel(0);
    const { cellH } = getDims();
    if (cellH !== 0) positionHostAt(maxYdisp, cellH);
    const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = nextScrollTop;
    pendingProgrammaticScrollTop = nextScrollTop;
    notifyScroll();
    trace("scroll-to-bottom:end", { ydisp: maxYdisp });
  };

  const scrollToRatio = (ratio: number): void => {
    trace("scroll-to-ratio:start");
    setUserHasVerticalScrollIntent(true);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(1, ratio));
    container.scrollTop = maxScrollTop * clamped;
    syncContainerScroll();
  };

  const scrollByWheelDelta = (deltaY: number): void => {
    if (deltaY === 0) return;
    trace("wheel");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop <= 0) return;
    setUserHasVerticalScrollIntent(true);
    const next = Math.max(0, Math.min(maxScrollTop, container.scrollTop + deltaY));
    if (next === container.scrollTop) {
      notifyScroll();
      return;
    }
    container.scrollTop = next;
    syncContainerScroll();
  };

  const scrollToXRatio = (ratio: number): void => {
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const clamped = Math.max(0, Math.min(1, ratio));
    container.scrollLeft = maxScrollLeft * clamped;
    notifyScroll();
  };

  const updateSpacer = (): void => {
    const { cellH, cellW } = getDims();
    if (cellH === 0 || cellW === 0) return;
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    let canvasLastY = -1;
    for (let ry = term.rows - 1; ry >= 0; ry--) {
      const absY = buffer.viewportY + ry;
      if (absY < 0 || absY >= buffer.length) continue;
      const line = buffer.getLine(absY);
      if (line && line.translateToString(true).trimEnd().length > 0) {
        canvasLastY = ry;
        break;
      }
    }
    const layout = computePtyHostLayout(
      {
        bufferLength: buffer.length,
        rows: term.rows,
        cols: term.cols,
        viewportY: buffer.viewportY,
        cellH,
        cellW,
        visibleContentHeight,
      },
      canvasLastY,
    );
    if (!layout) return;
    spacer.style.height = `${layout.spacerHeight}px`;
    spacer.style.width = `${layout.spacerWidth}px`;
    host.style.width = `${layout.hostWidth}px`;
    host.style.height = `${layout.hostHeight}px`;
    host.style.paddingTop = `${layout.hostPaddingTop}px`;
    lastSpacerUpdateAt = now();
    positionHostAt(buffer.viewportY, cellH, visibleContentHeight);
  };

  const scrollToYdisp = (ydisp: number): void => {
    syncing.internal = true;
    try {
      term.scrollToLine(ydisp);
    } finally {
      syncing.internal = false;
    }
  };

  const handlePendingNewFrame = (): PendingFrameResult => {
    if (!hasNewFrame()) return "none";
    consumeNewFrame();
    // 重连或 snapshot 重放时 DOM 尺寸会短暂变化，computeIsAtBottom 可能误判。
    // 用户已经表达过回看历史时，以用户意图为准，避免新输出把视图强行拉到底。
    if (!userHasVerticalScrollIntent) {
      scrollToBottom();
      return "followed";
    }
    if (!hasNewFramesWhileAway()) {
      setNewFramesWhileAway(true);
    }
    return "marked";
  };

  const syncContainerScroll = (): void => {
    trace("container-sync:start");
    const { cellH } = getDims();
    if (cellH === 0) return;
    const buffer = term.buffer.active;
    const { ydisp } = computeScrollTarget(container.scrollTop, {
      bufferLength: buffer.length,
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
      cellH,
      cellW: 1,
    });
    if (ydisp !== buffer.viewportY) {
      scrollToYdisp(ydisp);
    }
    positionHostAt(ydisp, cellH);
    notifyScroll();
    trace("container-sync:end", { ydisp });
  };

  const onContainerScroll = (): void => {
    trace("container-scroll");
    if (syncing.external) {
      notifyScroll();
      return;
    }
    const atBottom = computeIsAtBottom();
    const isPendingProgrammaticScroll =
      pendingProgrammaticScrollTop !== null &&
      Math.abs(container.scrollTop - pendingProgrammaticScrollTop) <= 1 &&
      !userHasVerticalScrollIntent;
    if (!atBottom && isPendingProgrammaticScroll) {
      pendingProgrammaticScrollTop = null;
      scrollToBottom();
      return;
    }
    pendingProgrammaticScrollTop = null;
    if (!atBottom) {
      setUserHasVerticalScrollIntent(true);
    }
    syncContainerScroll();
  };

  const onTermScroll = (): void => {
    trace("term-scroll");
    if (syncing.internal) return;
    const wasAtBottom = computeIsAtBottom();
    syncing.external = true;
    try {
      updateSpacer();
      const pendingFrame = handlePendingNewFrame();
      if (pendingFrame === "followed") {
        return;
      }
      if (pendingFrame === "none" && (wasAtBottom || !userHasVerticalScrollIntent)) {
        scrollToBottom();
        return;
      }
      const { cellH } = getDims();
      if (cellH !== 0) {
        const buffer = term.buffer.active;
        const { ydisp } = computeScrollTarget(container.scrollTop, {
          bufferLength: buffer.length,
          rows: term.rows,
          cols: term.cols,
          viewportY: buffer.viewportY,
          cellH,
          cellW: 1,
        });
        if (ydisp !== buffer.viewportY) {
          scrollToYdisp(ydisp);
        }
        positionHostAt(ydisp, cellH);
      }
      notifyScroll();
    } finally {
      syncing.external = false;
    }
  };

  const relayout = (): void => {
    trace("relayout:start");
    const wasAtBottom = computeIsAtBottom();
    updateSpacer();
    const pendingFrame = handlePendingNewFrame();
    if (pendingFrame === "followed") return;
    if (pendingFrame === "none" && (wasAtBottom || !userHasVerticalScrollIntent)) {
      scrollToBottom();
      return;
    }

    const { cellH } = getDims();
    if (cellH !== 0) {
      container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
      positionHostAt(term.buffer.active.viewportY, cellH);
    }
    notifyScroll();
    trace("relayout:end");
  };

  const onRender = (): void => {
    trace("render");
    updateSpacer();
    handlePendingNewFrame();
    notifyScroll();
  };

  updateSpacer();
  if (userHasVerticalScrollIntent) {
    notifyScroll();
  } else {
    scrollToBottom();
  }

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    scrollByWheelDelta(event.deltaY);
  };

  const onTouchStart = (event: TouchEvent): void => {
    touchScrollActive = true;
    touchStartY = event.touches?.[0]?.clientY ?? null;
    touchReviewNotified = false;
    setUserHasVerticalScrollIntent(true);
    trace("touchstart");
  };

  const onTouchMove = (event: TouchEvent): void => {
    const currentY = event.touches?.[0]?.clientY ?? null;
    trace("touchmove");
    if (touchStartY === null || currentY === null) return;
    if (Math.abs(currentY - touchStartY) < 8 || touchReviewNotified) return;
    touchReviewNotified = true;
    onTouchReviewStart?.();
    trace("touchmove:review");
  };

  const onTouchEnd = (): void => {
    touchScrollActive = false;
    touchStartY = null;
    touchReviewNotified = false;
    notifyAtBottom();
    trace("touchend");
  };

  container.addEventListener("wheel", onWheel, { passive: false, capture: true });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });
  container.addEventListener("scroll", onContainerScroll, { passive: true });
  const dispScroll = term.onScroll(onTermScroll);
  const dispRender = term.onRender(onRender);
  const ro = new ResizeObserver(relayout);
  ro.observe(container);
  ro.observe(host);

  const getDebugSnapshot = (): Omit<PtyDebugSnapshot, "frame"> => {
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;

    // 重新跑一遍 layout 计算（不写 DOM），用 expected 值和现有 spacer.height 比对漂移。
    let expectedSpacerHeight = 0;
    if (cellH > 0 && cellW > 0) {
      let canvasLastY = -1;
      for (let ry = term.rows - 1; ry >= 0; ry--) {
        const absY = buffer.viewportY + ry;
        if (absY < 0 || absY >= buffer.length) continue;
        const line = buffer.getLine(absY);
        if (line && line.translateToString(true).trimEnd().length > 0) {
          canvasLastY = ry;
          break;
        }
      }
      const layout = computePtyHostLayout(
        {
          bufferLength: buffer.length,
          rows: term.rows,
          cols: term.cols,
          viewportY: buffer.viewportY,
          cellH,
          cellW,
          visibleContentHeight,
        },
        canvasLastY,
      );
      expectedSpacerHeight = layout?.spacerHeight ?? 0;
    }
    const currentSpacerHeight = parseFloat(spacer.style.height) || 0;
    const currentHostTop = parseFloat(host.style.top) || 0;
    const currentHostHeight = parseFloat(host.style.height) || 0;
    const currentHostWidth = parseFloat(host.style.width) || 0;
    const currentHostPaddingTop = parseFloat(host.style.paddingTop) || 0;
    const currentSpacerWidth = parseFloat(spacer.style.width) || 0;

    return {
      ts: now(),
      container: {
        scrollTop: container.scrollTop,
        scrollLeft: container.scrollLeft,
        scrollHeight: container.scrollHeight,
        scrollWidth: container.scrollWidth,
        clientHeight: container.clientHeight,
        clientWidth: container.clientWidth,
        paddingTop,
        paddingBottom,
      },
      spacer: { height: currentSpacerHeight, width: currentSpacerWidth },
      host: {
        top: currentHostTop,
        height: currentHostHeight,
        width: currentHostWidth,
        paddingTop: currentHostPaddingTop,
      },
      term: {
        rows: term.rows,
        cols: term.cols,
        bufferLength: buffer.length,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
      },
      cell: { h: cellH, w: cellW },
      visibleContentHeight,
      pinned: !userHasVerticalScrollIntent,
      pendingProgrammaticScrollTop,
      touchScrollActive,
      expectedSpacerHeight,
      spacerDrift: currentSpacerHeight - expectedSpacerHeight,
      lastSpacerUpdateAt,
    };
  };

  return {
    dispose: () => {
      container.removeEventListener("scroll", onContainerScroll);
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      dispScroll.dispose();
      dispRender.dispose();
      ro.disconnect();
    },
    relayout,
    scrollToBottom,
    scrollToRatio,
    scrollToXRatio,
    getDebugSnapshot,
  };
}
