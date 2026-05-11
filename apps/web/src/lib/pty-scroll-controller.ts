import type { Terminal } from "@xterm/xterm";
import { computePtyHostLayout, computeScrollTarget, ydispToScrollTop } from "./pty-scroll";
import { appendPtyScrollTrace, isPtyScrollTraceEnabled } from "./pty-scroll-trace";
import type { PtyScrollDebugProbe } from "./pty-scroll-debug-snapshot";
import { parsePx } from "./pty-style-utils";
import { createPtyStyleWriter } from "./pty-style-writer";
import { findCanvasLastNonEmptyRow, measureXtermCellSize } from "./pty-xterm-metrics";

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
  // 暴露内部状态给 buildPtyScrollDebugSnapshot 拼装。生产路径不使用。
  getDebugProbe: () => PtyScrollDebugProbe;
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

  const getDims = (): { cellH: number; cellW: number } =>
    measureXtermCellSize(host, term) ?? { cellH: 0, cellW: 0 };

  const getVerticalInsets = (): { paddingTop: number; paddingBottom: number } => {
    const style = getComputedStyle(container);
    return {
      paddingTop: parsePx(style.paddingTop),
      paddingBottom: parsePx(style.paddingBottom),
    };
  };

  const styleWriter = createPtyStyleWriter();
  const setStyle = (el: HTMLElement, prop: string, value: string): void => {
    styleWriter.set(el, prop, value);
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
    // 只在 false → true 真实过渡时清 intent。初次 attach 时 lastAtBottom === null，
    // 即使容器恰好在底部，也要保留 caller 传入的 initialUserHasVerticalScrollIntent。
    if (next && lastAtBottom === false && !touchScrollActive) {
      setUserHasVerticalScrollIntent(false);
    }
    if (lastAtBottom === next) return;
    lastAtBottom = next;
    onAtBottomChange?.(next);
  };

  const notifyScroll = (): void => {
    notifyAtBottom();
    notifyScrollState();
  };

  const trace = (event: string, extra: { ydisp?: number } = {}): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const containerRect = container.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    appendPtyScrollTrace({
      t: performance.now(),
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
    setStyle(host, "position", "absolute");
    setStyle(host, "left", "0px");
    setStyle(host, "top", `${Math.max(0, ydisp * cellH + verticalOffset)}px`);
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

  // canvasLastY 扫描会跑到 term.rows 行，每帧 onRender 都跑一次浪费。
  // 用 buffer revision 当 cache key：xterm.onWriteParsed 写完就 ++，加上 viewportY/rows
  // 一起作 key——viewport 滚动或 resize 都会改 cache。
  let bufferRevision = 0;
  const dispWriteParsed = term.onWriteParsed?.(() => {
    bufferRevision += 1;
  });
  let cachedCanvasLastYKey: string | null = null;
  let cachedCanvasLastY = -1;
  const getCachedCanvasLastY = (): number => {
    const buffer = term.buffer.active;
    const key = `${bufferRevision}:${buffer.viewportY}:${buffer.length}:${term.rows}`;
    if (key === cachedCanvasLastYKey) return cachedCanvasLastY;
    cachedCanvasLastY = findCanvasLastNonEmptyRow(buffer, term.rows);
    cachedCanvasLastYKey = key;
    return cachedCanvasLastY;
  };

  const updateSpacer = (): void => {
    const { cellH, cellW } = getDims();
    if (cellH === 0 || cellW === 0) return;
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    const canvasLastY = getCachedCanvasLastY();
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
    setStyle(spacer, "height", `${layout.spacerHeight}px`);
    setStyle(spacer, "width", `${layout.spacerWidth}px`);
    setStyle(host, "width", `${layout.hostWidth}px`);
    setStyle(host, "height", `${layout.hostHeight}px`);
    setStyle(host, "paddingTop", `${layout.hostPaddingTop}px`);
    lastSpacerUpdateAt = performance.now();
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
    syncing.external = true;
    try {
      updateSpacer();
      const pendingFrame = handlePendingNewFrame();
      if (pendingFrame === "followed") {
        return;
      }
      // intent=true 表示用户在主动回看，即便几何上 atBottom=true 也不可强行回底——
      // reconnect 时新 buffer 短暂为空，空容器 + 跨周期保留的 intent 会被 wasAtBottom
      // 误清掉。只在 !intent（"未明示意图"）时按 atBottom 跟底。
      if (pendingFrame === "none" && !userHasVerticalScrollIntent) {
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
    updateSpacer();
    const pendingFrame = handlePendingNewFrame();
    if (pendingFrame === "followed") return;
    // 与 onTermScroll 同：intent=true 时不允许"几何 atBottom"反过来盖掉用户回看意图。
    // wasAtBottom 已经包含在 notifyAtBottom 的 false→true 过渡里负责清 intent，
    // 这里只需对"无意图"时跟底，避免 reconnect 空容器误清 intent。
    if (pendingFrame === "none" && !userHasVerticalScrollIntent) {
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
  // host 自身的尺寸由 updateSpacer 主动写，再 observe 它会形成"写→ ResizeObserver
  // → relayout → 又写"的反馈环。container 的尺寸（窗口/侧边栏变化）才需要 observe。
  // xterm 内部 cols/rows 变化通过 onScroll/onRender 已能捕获。
  const ro = new ResizeObserver(relayout);
  ro.observe(container);

  const getDebugProbe = (): PtyScrollDebugProbe => {
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    return {
      cellH,
      cellW,
      paddingTop,
      paddingBottom,
      canvasLastY: cellH > 0 && cellW > 0 ? getCachedCanvasLastY() : -1,
      userHasVerticalScrollIntent,
      pendingProgrammaticScrollTop,
      touchScrollActive,
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
      dispWriteParsed?.dispose();
      ro.disconnect();
    },
    relayout,
    scrollToBottom,
    scrollToRatio,
    scrollToXRatio,
    getDebugProbe,
  };
}
