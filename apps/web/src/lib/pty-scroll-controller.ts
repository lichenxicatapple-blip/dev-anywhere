import type { Terminal } from "@xterm/xterm";
import {
  computeHostTop,
  computePtyHostLayout,
  computeScrollAnchor,
  computeScrollTarget,
  ydispToScrollTop,
} from "./pty-scroll";
import {
  clearPtyHorizontalIntent,
  createInitialPtyHorizontalScrollState,
  markPtyHorizontalUserInput,
  reducePtyHorizontalContainerScroll,
  setPtyHorizontalPendingFollow,
  type PtyHorizontalScrollIntentTrace,
} from "./pty-horizontal-scroll-model";
import { decideContainerScrollSource } from "./pty-container-scroll-model";
import { decideCursorAwareClamp, decideScrollToBottomAction } from "./pty-follow-policy";
import { attachPtyScrollDomAdapter } from "./pty-scroll-dom-adapter";
import { createPtyScrollTraceAdapter } from "./pty-scroll-trace-adapter";
import {
  canPassiveFollow,
  createInitialPtyVerticalIntentState,
  isReviewing,
  reducePtyVerticalIntent,
  type PtyVerticalIntentEvent,
  type PtyVerticalIntentResult,
} from "./pty-vertical-intent-fsm";
import type { PtyScrollDebugProbe } from "./pty-scroll-debug-snapshot";
import { PTY_SCROLL_CONFIG } from "./pty-scroll-config";
import { decideFollowCursorY } from "./pty-scroll-model";
import { parsePx } from "./pty-style-utils";
import { createPtyStyleWriter } from "./pty-style-writer";
import { createPtyTouchScrollHandler } from "./pty-touch-scroll-handler";
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
  onTouchBoundaryPrevent?: () => void;
  atBottomThreshold?: number;
}

interface PtyScrollController {
  dispose: () => void;
  relayout: () => void;
  // reason 是 trace label, 让用户报回的 trace 能区分哪条外部路径触发了 scrollToBottom
  // (rawInput / backToBottomButton / 内部 follow / init / ...)。opts.force=true 是
  // 用户明示动作 (BackToBottom 按钮 / init / 修 stale state) 才能压过 userIntent;
  // 默认被动 caller (rawInput / pendingFrame / relayout / termScroll) 在 intent=true
  // 时整段 no-op。把 invariant 收到 controller 内部, 新加 caller 默认就对。
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  // 浏览器从后台 / bfcache 恢复时可能先还原一个旧 DOM scrollTop。生命周期恢复统一
  // 以实时终端为准回到底部；前台主动回看仍由 scrollToBottom 的 passive guard 保护。
  preparePageResumeRestore: () => void;
  restorePageResume: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  resetHorizontalScroll: (reason?: string) => void;
  markHorizontalScrollIntent: (reason?: string) => void;
  traceRawInputFollowScheduled: (source?: string) => void;
  traceRawInputFollowFire: () => void;
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
    onTouchBoundaryPrevent,
    atBottomThreshold = PTY_SCROLL_CONFIG.bottom.defaultThresholdPx,
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
  let verticalIntent = createInitialPtyVerticalIntentState({
    initialIntent: initialUserHasVerticalScrollIntent,
    scrollTop: container.scrollTop,
  });
  let pendingProgrammaticScrollTop: number | null = null;
  let lastSpacerUpdateAt: number | null = null;
  // cellH=0 时 syncContainerScroll 早返回不能动 host/viewportY,但用户的 scrollTop 已经
  // 改了。这一帧不补,host 会停在旧 ydisp 上,直到下一次显式 user scroll 才会再次走到
  // syncContainerScroll。production blank-render 候选成因之一就是 xterm screen 那一帧
  // measure 不到尺寸 → 这条路径漏掉一次 sync。用这个标志让 relayout / onRender 在 cellH
  // 恢复后立刻补一次 sync,不依赖用户再滚一下。
  let pendingContainerSyncRetry = false;
  // followCursorY 主动改写 scrollTop 后,容器 scroll 事件会走 onContainerScroll,几何上
  // !atBottom 会被解释成"用户回看"并把 intent 置 true,下次 followCursorY 就被 intent 卡住。
  // 用这个 mark 把"我们刚刚程序化滚到这里"这条信息透传给 onContainerScroll,让它别误判。
  let pendingFollowCursorScrollTop: number | null = null;
  // 横向同样需要区分 "我们刚刚 followCursorX 改 scrollLeft" vs "用户主动横向滚",
  // 否则用户滚到光标视窗外 → onRender → followCursorX snap 回 → onContainerScroll
  // 误把这次改写当成用户滚动 → 状态错乱。
  let horizontalState = createInitialPtyHorizontalScrollState();
  // 纵向同样需要"用户向下滚到底"的方向判定来释放 intent。longHost 模式下
  // isAtBottom = cursorInViewport, 用户小幅 wheel up 时 cursor 仍可见 → atBottom 仍 true,
  // 仅看 atBottom + 时间窗会把刚 set 的 intent 立刻清掉。改成跟 onContainerScroll 拿到的
  // delta 比对: 只有 scrollTop 真的增大且抵达 atBottom 时才认为用户主动收起回看意图。
  let lastSeenScrollTop = 0;
  // 页面从后台 / keepalive 隐藏层恢复时,浏览器可能先回放旧 scrollTop 或 touch scroll。
  // 如果隐藏前语义上在 following,这些恢复噪音不能抢先把 intent 改成 reviewing。
  let pageResumeRestorePendingFromFollowing = false;
  // 进入页面时按"几何贴底"一次定锚 (终端心智), 之后只在"光标行真的变了"时让
  // followCursorY 接管把光标拉回视野。无变动的 onRender 帧 (focus 切换 / theme 重绘 /
  // 同一 buffer 重 paint) 不应改 scrollTop, 否则进入瞬间就会从底吸底跳成 cursor 居中,
  // UX 跳变。null 表示"还没记录过", 等同于"上一帧没看到光标行"。
  let prevCursorBufferRow: number | null = null;
  let lastRawInputFollowAt: number | null = null;
  let pendingTouchScrollNotifyFrame: number | null = null;
  let pendingTouchScrollNotifyCancel: ((handle: number) => void) | null = null;

  const userHasVerticalScrollIntent = (): boolean => isReviewing(verticalIntent);

  const traceAdapter = createPtyScrollTraceAdapter({
    container,
    host,
    term,
    atBottomThreshold,
    getDims,
    getVerticalInsets,
    getPrevCursorBufferRow: () => prevCursorBufferRow,
    getPendingProgrammaticScrollTop: () => pendingProgrammaticScrollTop,
    getPendingFollowCursorScrollTop: () => pendingFollowCursorScrollTop,
    getPendingFollowCursorScrollLeft: () => horizontalState.pendingFollowLeft,
    getPendingContainerSyncRetry: () => pendingContainerSyncRetry,
    getHorizontalIntent: () => horizontalState.intent,
    getVerticalIntent: () => verticalIntent,
    getUserHasVerticalScrollIntent: () => userHasVerticalScrollIntent(),
  });
  const trace = traceAdapter.trace;

  const traceHorizontalIntent = (event: PtyHorizontalScrollIntentTrace | null): void => {
    if (!event) return;
    if (event.kind === "ignore") {
      trace("horizontal-intent:ignore", { details: event.details });
      return;
    }
    trace(`horizontal-intent:${event.kind}`, { details: event.details });
  };

  const hasHorizontalOverflow = (): boolean =>
    container.scrollWidth > container.clientWidth + atBottomThreshold;

  const clearHorizontalIntentIfUnscrollable = (site: string): boolean => {
    if (hasHorizontalOverflow()) return false;
    const result = clearPtyHorizontalIntent(horizontalState, {
      details: `site=${site} reason=not-scrollable scrollWidth=${container.scrollWidth} clientWidth=${container.clientWidth}`,
      scrollLeft: container.scrollLeft,
    });
    horizontalState = result.state;
    traceHorizontalIntent(result.trace);
    if (container.scrollLeft !== 0) {
      container.scrollLeft = 0;
      horizontalState = { ...horizontalState, lastSeenLeft: 0 };
    }
    return true;
  };

  const markHorizontalUserInput = (details: string): void => {
    if (!hasHorizontalOverflow()) {
      clearHorizontalIntentIfUnscrollable("markHorizontalUserInput");
      return;
    }
    const result = markPtyHorizontalUserInput(horizontalState, {
      now: performance.now(),
      details,
    });
    horizontalState = result.state;
    traceHorizontalIntent(result.trace);
  };

  const getScrollState = (): PtyScrollState => ({
    scrollTop: container.scrollTop,
    scrollLeft: container.scrollLeft,
    scrollHeight: container.scrollHeight,
    scrollWidth: container.scrollWidth,
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth,
    scrollable: container.scrollHeight > container.clientHeight + atBottomThreshold,
    horizontalScrollable: hasHorizontalOverflow(),
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

  // anchor 集中化: isAtBottom / bottomScrollTop / cursorInViewport 三件事按
  // host 是否高于可视区分两条路, 这条分支只在 computeScrollAnchor 里出现一次,
  // 其他地方都拿这个快照。每次调用都从当前 DOM/term 取最新值, 不缓存。
  const getCurrentAnchor = () => {
    const { cellH } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const buffer = term.buffer.active;
    return computeScrollAnchor({
      rows: term.rows,
      cellH,
      bufferLength: buffer.length,
      cursorBufferRow: buffer.baseY + buffer.cursorY,
      visibleContentHeight: Math.max(0, container.clientHeight - paddingTop - paddingBottom),
      paddingTop,
      paddingBottom,
      containerScrollTop: container.scrollTop,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      atBottomThreshold,
    });
  };

  const notifyAtBottom = (): void => {
    const next = getCurrentAnchor().isAtBottom;
    if (lastAtBottom === next) return;
    lastAtBottom = next;
    onAtBottomChange?.(next);
  };

  const notifyScroll = (): void => {
    notifyAtBottom();
    notifyScrollState();
  };

  const shouldDeferHostCommitForYdisp = (): boolean => verticalIntent.touchActive;

  const cancelPendingTouchScrollNotify = (): void => {
    if (pendingTouchScrollNotifyFrame === null) return;
    pendingTouchScrollNotifyCancel?.(pendingTouchScrollNotifyFrame);
    pendingTouchScrollNotifyFrame = null;
    pendingTouchScrollNotifyCancel = null;
  };

  const scheduleTouchScrollNotify = (): void => {
    if (pendingTouchScrollNotifyFrame !== null) return;
    const fire = (): void => {
      pendingTouchScrollNotifyFrame = null;
      pendingTouchScrollNotifyCancel = null;
      notifyScroll();
    };
    if (typeof window.requestAnimationFrame === "function") {
      pendingTouchScrollNotifyFrame = window.requestAnimationFrame(fire);
      pendingTouchScrollNotifyCancel =
        typeof window.cancelAnimationFrame === "function"
          ? (handle) => window.cancelAnimationFrame(handle)
          : null;
      return;
    }
    pendingTouchScrollNotifyFrame = window.setTimeout(fire, 16);
    pendingTouchScrollNotifyCancel = (handle) => window.clearTimeout(handle);
  };

  const flushPendingTouchScrollNotify = (): void => {
    if (pendingTouchScrollNotifyFrame === null) return;
    cancelPendingTouchScrollNotify();
    notifyScroll();
  };

  const traceRawInputFollowScheduled = (source: string = "rawInput"): void => {
    lastRawInputFollowAt = performance.now();
    trace(`rawInputFollow:scheduled[${source}]`);
  };

  const traceRawInputFollowFire = (): void => {
    lastRawInputFollowAt = performance.now();
    trace("rawInputFollow:fire");
  };

  const dispatchVerticalIntent = (event: PtyVerticalIntentEvent): PtyVerticalIntentResult => {
    const previousReviewing = isReviewing(verticalIntent);
    const result = reducePtyVerticalIntent(verticalIntent, event, { atBottomThreshold });
    verticalIntent = result.state;

    if (result.trace) {
      trace(`intent:${result.trace.action}`, {
        details: `id=${result.trace.id} reason=${result.trace.reason}`,
      });
    }

    const nextReviewing = isReviewing(verticalIntent);
    if (previousReviewing !== nextReviewing) {
      onUserVerticalScrollIntentChange?.(nextReviewing);
    }
    if (result.notifyTouchReviewStart) {
      onTouchReviewStart?.();
    }
    return result;
  };

  const positionHostAt = (ydisp: number, cellH: number, visibleContentHeight?: number): void => {
    if (cellH <= 0) return;
    const resolvedVisibleContentHeight =
      visibleContentHeight ??
      (() => {
        const { paddingTop, paddingBottom } = getVerticalInsets();
        return Math.max(0, container.clientHeight - paddingTop - paddingBottom);
      })();
    const top = computeHostTop({
      ydisp,
      rows: term.rows,
      cellH,
      visibleContentHeight: resolvedVisibleContentHeight,
    });
    const prevTopPx = host.style.top;
    const nextTopPx = `${top}px`;
    setStyle(host, "position", "absolute");
    setStyle(host, "left", "0px");
    setStyle(host, "top", nextTopPx);
    // host.top 没变那一帧 (focus 切换 / theme 重绘 / 同 buffer 重 paint) 不 trace, 减少稳态噪音。
    if (prevTopPx === nextTopPx) return;
    trace("host-position", {
      ydisp,
      details: `${prevTopPx || "0px"}->${nextTopPx}`,
    });
  };

  const scrollToBottom = (reason: string = "internal", opts: { force?: boolean } = {}): void => {
    // 默认 respect intent: intent=true (用户在回看) 时整段 no-op, 不清 intent / 不 trace /
    // 不写 scrollTop / 不写 host。被动 caller (rawInput / pendingFrame / relayout /
    // termScroll) 应当被回看意图压过, 否则用户每次想看历史都会被远端 / xterm onData
    // 自动响应 / 焦点切换之类的事件无形拉走。
    // force=true 是用户明示动作 (BackToBottom / init / 修 stale state programmaticDrift)
    // 的 opt-out, 这条路径仍清 intent + 拉底, 表示"用户想从回看模式退出回到 follow"。
    // no-op 早返: 已在底 + intent=false + viewportY=maxYdisp → 不工作不 trace。
    // pendingContainerSyncRetry=false 语义保留 (scrollToBottom 永远清干净 stale state)。
    const expectedYdisp = Math.max(0, term.buffer.active.length - term.rows);
    const anchor = getCurrentAnchor();
    const action = decideScrollToBottomAction({
      force: opts.force ?? false,
      reviewing: userHasVerticalScrollIntent(),
      viewportY: term.buffer.active.viewportY,
      expectedYdisp,
      scrollTop: container.scrollTop,
      bottomScrollTop: anchor.bottomScrollTop,
      atBottom: anchor.isAtBottom,
    }).action;
    if (action === "blocked-by-review") {
      return;
    }
    if (action === "noop") {
      pendingContainerSyncRetry = false;
      return;
    }
    trace(`scroll-to-bottom:start[${reason}]`);
    dispatchVerticalIntent({
      type: "scroll-to-bottom",
      force: opts.force ?? false,
      reason,
    });
    const maxYdisp = Math.max(0, term.buffer.active.length - term.rows);
    syncing.internal = true;
    try {
      term.scrollToLine(maxYdisp);
    } finally {
      syncing.internal = false;
    }
    const { cellH } = getDims();
    if (cellH !== 0) positionHostAt(maxYdisp, cellH);
    const nextScrollTop = getCurrentAnchor().bottomScrollTop;
    container.scrollTop = nextScrollTop;
    pendingProgrammaticScrollTop = nextScrollTop;
    // 把当前光标行作为基线记下: 紧接其后的 onRender 走 followCursorY 时, prev == current 跳过,
    // 不会把刚刚摆到几何底的视口又拉成 cursor 居中。光标真的"动"了 (claude 重画 / 用户敲)
    // 才让 followCursorY 接管。
    prevCursorBufferRow = term.buffer.active.baseY + term.buffer.active.cursorY;
    notifyScroll();
    // 清零必须放在最末尾: container.scrollTop = nextScrollTop 会同步触发 onContainerScroll →
    // syncContainerScroll, 此时若 cellH=0 会重新置位 retry flag。开头清零的话这里又会被覆盖,
    // 让 scrollToBottom 的"重置 stale state"语义不真。在所有同步副作用后再清,确保边界干净。
    pendingContainerSyncRetry = false;
    trace("scroll-to-bottom:end", { ydisp: maxYdisp });
  };

  const preparePageResumeRestore = (): void => {
    pageResumeRestorePendingFromFollowing = true;
    trace("page-resume:prepare-follow");
    if (userHasVerticalScrollIntent()) {
      dispatchVerticalIntent({
        type: "scroll-to-bottom",
        force: true,
        reason: "pageResumePrepare",
      });
    }
  };

  const restorePageResume = (): void => {
    preparePageResumeRestore();
    updateSpacer();
    scrollToBottom("pageResume", { force: true });
    pageResumeRestorePendingFromFollowing = false;
  };

  const scrollToRatio = (ratio: number): void => {
    trace("scroll-to-ratio:start");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(1, ratio));
    const nextScrollTop = maxScrollTop * clamped;
    dispatchVerticalIntent({
      type: "scroll-to-ratio",
      ratio: clamped,
      scrollTop: nextScrollTop,
    });
    container.scrollTop = nextScrollTop;
    syncContainerScroll();
  };

  const scrollByWheelDelta = (deltaY: number): void => {
    if (deltaY === 0) return;
    trace("wheel");
    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    // In long-host mode the real pinned bottom is cursor-aware, and can sit above
    // the DOM geometric bottom. Wheel scrolling must use that same boundary;
    // otherwise wheel-down at bottom overshoots, then pending output snaps back.
    const maxScrollTop = Math.min(domMaxScrollTop, getCurrentAnchor().bottomScrollTop);
    if (maxScrollTop <= 0) {
      trace("wheel:max-zero");
      return;
    }
    const previous = container.scrollTop;
    const next = Math.max(0, Math.min(maxScrollTop, previous + deltaY));
    if (next === previous) {
      // 已经 clamp 到边界 (顶 / 底), 真实 scrollTop 不动 — 不该把 intent 再 set 一遍,
      // 否则用户在底反复 wheel down 会把 output 重新 pause。
      trace("wheel:clamped");
      notifyScroll();
      return;
    }
    container.scrollTop = next;
    lastSeenScrollTop = next;
    syncContainerScroll();
    // 向下滚到底 (next > previous 且抵达 atBottom) 释放 intent。向上滚不清, 即便
    // longHost 模式下 cursor 仍可见 (atBottom 仍 true)。
    dispatchVerticalIntent({
      type: "wheel",
      deltaY,
      previousScrollTop: previous,
      nextScrollTop: next,
      reachedCursorAwareBottom:
        next > previous &&
        next >= maxScrollTop - atBottomThreshold &&
        getCurrentAnchor().isAtBottom,
    });
  };

  const scrollToXRatio = (ratio: number): void => {
    if (!hasHorizontalOverflow()) {
      clearHorizontalIntentIfUnscrollable("scrollToXRatio");
      notifyScroll();
      return;
    }
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const clamped = Math.max(0, Math.min(1, ratio));
    container.scrollLeft = maxScrollLeft * clamped;
    markHorizontalUserInput(`site=scrollToXRatio ratio=${clamped}`);
    horizontalState = { ...horizontalState, lastSeenLeft: container.scrollLeft };
    notifyScroll();
  };

  const resetHorizontalScroll = (reason: string = "external"): void => {
    const previous = container.scrollLeft;
    const result = clearPtyHorizontalIntent(horizontalState, {
      details: `site=resetHorizontalScroll reason=${reason}`,
      scrollLeft: 0,
    });
    horizontalState = result.state;
    traceHorizontalIntent(result.trace);
    if (previous !== 0) {
      container.scrollLeft = 0;
    }
    trace(`horizontal-scroll-reset[${reason}]`, {
      details: `scrollLeft=${previous}->${container.scrollLeft}`,
    });
    notifyScroll();
  };

  const markHorizontalScrollIntent = (reason: string = "external"): void => {
    markHorizontalUserInput(`site=${reason}`);
  };

  // canvasLastY 扫描会跑到 term.rows 行，每帧 onRender 都跑一次浪费。
  // 用 buffer revision 当 cache key：xterm.onWriteParsed 写完就 ++，加上 viewportY/rows
  // 一起作 key——viewport 滚动或 resize 都会改 cache。
  let bufferRevision = 0;
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
        cursorY: buffer.cursorY,
        cellH,
        cellW,
        visibleContentHeight,
      },
      canvasLastY,
    );
    if (!layout) return;
    setStyle(spacer, "overflow", "hidden");
    setStyle(spacer, "height", `${layout.spacerHeight}px`);
    setStyle(spacer, "width", `${layout.spacerWidth}px`);
    setStyle(host, "width", `${layout.hostWidth}px`);
    setStyle(host, "height", `${layout.hostHeight}px`);
    setStyle(host, "paddingTop", `${layout.hostPaddingTop}px`);
    lastSpacerUpdateAt = performance.now();
    positionHostAt(buffer.viewportY, cellH, visibleContentHeight);
  };

  const syncViewportAndHostAt = (
    ydisp: number,
    cellH: number,
    opts: { deferHostUntilRender?: boolean } = {},
  ): void => {
    if (ydisp === term.buffer.active.viewportY) {
      if (!opts.deferHostUntilRender) {
        positionHostAt(ydisp, cellH);
      }
      return;
    }

    syncing.internal = true;
    try {
      if (opts.deferHostUntilRender) {
        term.scrollToLine(ydisp);
        return;
      }
      // Most callers keep host geometry ahead of xterm's synchronous onScroll observers.
      // Native scrollers are different: the compositor has already moved the scroll
      // container, so moving host.top before xterm paints the new row exposes a one-row
      // visual jump. Those callers defer host positioning until onRender.
      positionHostAt(ydisp, cellH);
      term.scrollToLine(ydisp);
    } finally {
      syncing.internal = false;
    }
  };

  const handlePendingNewFrame = (): PendingFrameResult => {
    if (!hasNewFrame()) return "none";
    consumeNewFrame();
    // 重连或 snapshot 重放时 DOM 尺寸会短暂变化, anchor.isAtBottom 可能误判。
    // 用户已经表达过回看历史时, 以用户意图为准, 避免新输出把视图强行拉到底。
    if (canPassiveFollow(verticalIntent)) {
      // follow/hold 冗余, scrollToBottom 内部已 trace `scroll-to-bottom:start[pendingFrame]` 标 reason。
      scrollToBottom("pendingFrame");
      return "followed";
    }
    if (!hasNewFramesWhileAway()) {
      setNewFramesWhileAway(true);
    }
    return "marked";
  };

  const getYdispForScrollTop = (scrollTop: number, cellH: number): number => {
    const buffer = term.buffer.active;
    return computeScrollTarget(scrollTop, {
      bufferLength: buffer.length,
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
      cellH,
      cellW: 1,
    }).ydisp;
  };

  const syncContainerScroll = (opts: { deferHostUntilRender?: boolean } = {}): void => {
    cancelPendingTouchScrollNotify();
    trace("container-sync:start");
    const { cellH } = getDims();
    if (cellH === 0) {
      // screen 还没 measure 到。先记下,等 onRender / relayout 补。
      pendingContainerSyncRetry = true;
      return;
    }
    pendingContainerSyncRetry = false;
    const ydisp = getYdispForScrollTop(container.scrollTop, cellH);
    syncViewportAndHostAt(ydisp, cellH, {
      deferHostUntilRender: opts.deferHostUntilRender ?? shouldDeferHostCommitForYdisp(),
    });
    notifyScroll();
    trace("container-sync:end", { ydisp });
  };

  const isRecentTouchNativeScroll = (): boolean =>
    verticalIntent.touchActive || touchHandler.isRecentNativeScroll();

  const skipSameRowTouchScrollSync = (effectiveScrollTop: number): boolean => {
    if (!isRecentTouchNativeScroll()) return false;
    const { cellH } = getDims();
    if (cellH === 0) return false;
    const ydisp = getYdispForScrollTop(effectiveScrollTop, cellH);
    if (ydisp !== term.buffer.active.viewportY) return false;
    scheduleTouchScrollNotify();
    trace("container-sync:skip[same-row-touch]", {
      ydisp,
      details: `scrollTop=${Math.round(effectiveScrollTop)} viewportY=${term.buffer.active.viewportY}`,
    });
    return true;
  };

  const clampCursorAwareBottomOverscroll = (rawScrollTop: number): number => {
    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const anchor = getCurrentAnchor();
    const decision = decideCursorAwareClamp({
      rawScrollTop,
      bottomScrollTop: anchor.bottomScrollTop,
      domMaxScrollTop,
    });
    if (decision.action === "keep") {
      return decision.scrollTop;
    }
    trace("container-scroll:clamp-cursor-bottom", {
      details: `prev=${rawScrollTop} next=${decision.scrollTop} domMax=${domMaxScrollTop}`,
    });
    container.scrollTop = decision.scrollTop;
    pendingProgrammaticScrollTop = null;
    pendingFollowCursorScrollTop = null;
    return decision.scrollTop;
  };

  const touchHandler = createPtyTouchScrollHandler({
    container,
    atBottomThreshold,
    trace,
    getPageResumePending: () => pageResumeRestorePendingFromFollowing,
    getVerticalIntent: () => verticalIntent,
    dispatchVerticalIntent,
    getCurrentAnchor,
    getLastSeenScrollTop: () => lastSeenScrollTop,
    hasHorizontalOverflow,
    clearHorizontalIntentIfUnscrollable,
    markHorizontalUserInput,
    onTouchBoundaryPrevent,
    notifyAtBottom,
    flushPendingTouchScrollNotify,
  });

  const restoreImpossibleTouchScrollJump = (effectiveScrollTop: number): boolean => {
    const expectation = touchHandler.getScrollExpectation();
    if (!expectation) return false;
    const { touchStartScrollTop, touchStartY, currentY, gestureBaseScrollTop, expectedScrollTop } =
      expectation;
    const hasTouchMovement = Math.abs(currentY - touchStartY) > 0.5;
    const jumpedToDomTop =
      effectiveScrollTop <= atBottomThreshold && gestureBaseScrollTop > container.clientHeight;
    const hostTop = parseFloat(host.style.top || "0");
    const anchor = getCurrentAnchor();
    const jumpedToHostTop =
      Number.isFinite(hostTop) &&
      Math.abs(effectiveScrollTop - hostTop) <= atBottomThreshold &&
      Math.abs(anchor.bottomScrollTop - hostTop) <= container.clientHeight + atBottomThreshold &&
      Math.abs(expectedScrollTop - effectiveScrollTop) >
        PTY_SCROLL_CONFIG.touch.hostTopJumpMinThresholdPx;
    if (!hasTouchMovement && !jumpedToDomTop && !jumpedToHostTop) return false;

    const impossibleJumpThreshold = Math.max(
      PTY_SCROLL_CONFIG.touch.scrollJumpMinThresholdPx,
      container.clientHeight * 1.25,
    );
    if (
      !jumpedToHostTop &&
      Math.abs(effectiveScrollTop - expectedScrollTop) <= impossibleJumpThreshold
    ) {
      return false;
    }

    trace("container-scroll:restore-touch-impossible-jump", {
      details: [
        `scrollTop=${Math.round(effectiveScrollTop)}`,
        `expected=${Math.round(expectedScrollTop)}`,
        `diff=${Math.round(effectiveScrollTop - expectedScrollTop)}`,
        `threshold=${Math.round(impossibleJumpThreshold)}`,
        `touchStart=${Math.round(touchStartScrollTop)}`,
        jumpedToHostTop ? "hostTop=1" : null,
        `startY=${Math.round(touchStartY)}`,
        `currentY=${Math.round(currentY)}`,
      ]
        .filter(Boolean)
        .join(" "),
    });
    container.scrollTop = expectedScrollTop;
    lastSeenScrollTop = expectedScrollTop;
    syncContainerScroll({ deferHostUntilRender: true });
    return true;
  };

  const restoreRecentRawInputLayoutDrift = (
    effectiveScrollTop: number,
    atBottom: boolean,
    verticalDelta: number,
  ): boolean => {
    if (atBottom) return false;
    if (verticalIntent.touchActive) return false;
    if (!canPassiveFollow(verticalIntent)) return false;
    const recentRawInputFollow =
      lastRawInputFollowAt !== null &&
      performance.now() - lastRawInputFollowAt <= PTY_SCROLL_CONFIG.rawInput.recentLayoutDriftMs;
    if (!recentRawInputFollow) return false;

    const anchor = getCurrentAnchor();
    trace("container-scroll:restore-raw-input-layout-bottom", {
      details: `scrollTop=${effectiveScrollTop} bottom=${anchor.bottomScrollTop}`,
    });
    dispatchVerticalIntent({
      type: "container-scroll",
      source: "programmatic-bottom",
      scrollTop: effectiveScrollTop,
      atCursorAwareBottom: atBottom,
      verticalDelta,
    });
    scrollToBottom("rawInputLayoutDrift");
    return true;
  };

  const onContainerScroll = (): void => {
    trace("container-scroll");
    const horizontalResult = reducePtyHorizontalContainerScroll(horizontalState, {
      hasOverflow: hasHorizontalOverflow(),
      scrollLeft: container.scrollLeft,
      now: performance.now(),
      nativeIntentThresholdPx: PTY_SCROLL_CONFIG.horizontal.nativeIntentThresholdPx,
    });
    horizontalState = horizontalResult.state;
    traceHorizontalIntent(horizontalResult.trace);
    if (horizontalResult.resetScrollLeft) {
      container.scrollLeft = 0;
    }
    // 纵向 delta: 区分用户主动向下滚 vs 向上滚, 用于 intent 释放方向判定。每条
    // scroll 事件都更新 lastSeen, 程序化与用户路径共用。
    const rawScrollTop = container.scrollTop;
    const previousSeenScrollTop = lastSeenScrollTop;
    const verticalDelta = rawScrollTop - lastSeenScrollTop;
    const effectiveScrollTop = clampCursorAwareBottomOverscroll(rawScrollTop);
    if (verticalIntent.touchActive) {
      const expectation = touchHandler.getScrollExpectation();
      trace("container-scroll:touch-active", {
        details:
          touchHandler.describeScrollExpectation(
            expectation,
            rawScrollTop,
            effectiveScrollTop,
            previousSeenScrollTop,
            verticalDelta,
          ) ?? `raw=${Math.round(rawScrollTop)} effective=${Math.round(effectiveScrollTop)}`,
      });
    }
    lastSeenScrollTop = effectiveScrollTop;
    const sourceDecision = decideContainerScrollSource({
      syncingExternal: syncing.external,
      effectiveScrollTop,
      pendingFollowTop: pendingFollowCursorScrollTop,
      pendingProgrammaticTop: pendingProgrammaticScrollTop,
      atBottom: getCurrentAnchor().isAtBottom,
      canPassiveFollow: canPassiveFollow(verticalIntent),
    });
    pendingFollowCursorScrollTop = sourceDecision.nextPendingFollowTop;
    pendingProgrammaticScrollTop = sourceDecision.nextPendingProgrammaticTop;

    if (sourceDecision.action === "external-sync") {
      dispatchVerticalIntent({
        type: "container-scroll",
        source: "external-sync",
        scrollTop: effectiveScrollTop,
        atCursorAwareBottom: getCurrentAnchor().isAtBottom,
        verticalDelta,
      });
      notifyScroll();
      return;
    }
    // followCursorY 自己刚刚程序化设了 scrollTop,不能让本次 scroll 事件被当成"用户回看"
    // 而把 intent 置 true; 也不要走 scrollToBottom 兜底,否则会和 followCursorY 互踩。
    if (sourceDecision.action === "programmatic-follow") {
      dispatchVerticalIntent({
        type: "container-scroll",
        source: "programmatic-follow",
        scrollTop: effectiveScrollTop,
        atCursorAwareBottom: getCurrentAnchor().isAtBottom,
        verticalDelta,
      });
      notifyScroll();
      return;
    }
    const atBottom = getCurrentAnchor().isAtBottom;
    if (sourceDecision.action === "programmatic-drift") {
      dispatchVerticalIntent({
        type: "container-scroll",
        source: "programmatic-bottom",
        scrollTop: effectiveScrollTop,
        atCursorAwareBottom: atBottom,
        verticalDelta,
      });
      scrollToBottom("programmaticDrift");
      return;
    }
    if (restoreImpossibleTouchScrollJump(effectiveScrollTop)) {
      return;
    }
    if (restoreRecentRawInputLayoutDrift(effectiveScrollTop, atBottom, verticalDelta)) {
      return;
    }
    if (pageResumeRestorePendingFromFollowing) {
      trace("container-scroll:page-resume-pending", {
        details: `scrollTop=${effectiveScrollTop} bottom=${getCurrentAnchor().bottomScrollTop}`,
      });
      dispatchVerticalIntent({
        type: "container-scroll",
        source: "programmatic-bottom",
        scrollTop: effectiveScrollTop,
        atCursorAwareBottom: atBottom,
        verticalDelta,
      });
      syncContainerScroll();
      return;
    }
    // 用户主动向下滚抵达 atBottom 时释放 intent, 让 output 重新跟随。阈值 atBottomThreshold
    // (默认 8px) 屏蔽浏览器 subpixel rounding / 浮点 jitter。atBottom alone 不是 clear 条件;
    // FSM 同时检查方向、来源以及 touchActive。
    dispatchVerticalIntent({
      type: "container-scroll",
      source: "user",
      scrollTop: effectiveScrollTop,
      atCursorAwareBottom: atBottom,
      verticalDelta,
    });
    if (skipSameRowTouchScrollSync(effectiveScrollTop)) {
      return;
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
      if (pendingFrame === "none" && canPassiveFollow(verticalIntent)) {
        scrollToBottom("termScroll");
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
        syncViewportAndHostAt(ydisp, cellH);
      }
      notifyScroll();
    } finally {
      syncing.external = false;
    }
  };

  const relayout = (): void => {
    // start/end 不 trace, layout 真改了 (host-position) / scrollToBottom 真触发 / pending-sync-retry-fire
    // 这些子路径自己有独立 trace, 框 trace 是稳态噪音。
    updateSpacer();
    const pendingFrame = handlePendingNewFrame();
    if (pendingFrame === "followed") return;
    // 与 onTermScroll 同：intent=true 时不允许"几何 atBottom"反过来盖掉用户回看意图。
    // wasAtBottom 已经包含在 notifyAtBottom 的 false→true 过渡里负责清 intent，
    // 这里只需对"无意图"时跟底，避免 reconnect 空容器误清 intent。
    if (pendingFrame === "none" && canPassiveFollow(verticalIntent)) {
      scrollToBottom("relayout");
      return;
    }

    const { cellH } = getDims();
    if (cellH !== 0) {
      // 上一次 syncContainerScroll 因 cellH=0 漏掉了 user scroll 时,先按用户当前 scrollTop
      // 把 viewportY 和 host 补齐——再走"按 viewportY 强制对齐 scrollTop"那条路,否则会把
      // 用户的 scrollTop yank 回旧 viewportY 对应位置。
      if (pendingContainerSyncRetry) {
        trace("pending-sync-retry-fire");
        syncContainerScroll();
      } else {
        const currentYdisp = getYdispForScrollTop(container.scrollTop, cellH);
        const viewportScrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
        if (currentYdisp !== term.buffer.active.viewportY) {
          container.scrollTop = viewportScrollTop;
        } else if (Math.abs(container.scrollTop - viewportScrollTop) > 1) {
          trace("relayout:preserve-host-offset", {
            details: `scrollTop=${Math.round(container.scrollTop)} viewportTop=${Math.round(viewportScrollTop)} ydisp=${currentYdisp}`,
          });
        }
        positionHostAt(term.buffer.active.viewportY, cellH);
      }
    }
    // 注: pendingContainerSyncRetry 分支里 syncContainerScroll 自己已经 notifyScroll 一次,
    // 这里再 notifyScroll 一次是冗余但无害的——notifyAtBottom / notifyScrollState 都有
    // idempotent guard (lastAtBottom / lastScrollStateKey),重复调用直接早返回。保持收尾
    // 一行 notifyScroll 让 relayout 主路径读起来线性,不为了这一次冗余加分支。
    notifyScroll();
  };

  // server-owned rows 场景下 host 可能比可视区高, host 内只能看到一段 N 行子窗口。光标
  // 行落在 N 行外就肉眼看不见, 用户只能盲输 (原 bug 现场)。
  // 设计: 进入页面靠 scrollToBottom 几何贴底定锚, followCursorY 只在"光标行真动了"那一帧
  // 把视口拉到光标处。无变动的 onRender 帧 (focus 切换 / theme 重绘 / 同 buffer 重 paint)
  // 不该改 scrollTop, 否则进入瞬间就跳成 cursor 居中, 失去终端"贴底"心智。
  const followCursorY = (): void => {
    const { cellH } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    const prevRow = prevCursorBufferRow;
    const anchor = getCurrentAnchor();
    const decision = decideFollowCursorY({
      reviewing: userHasVerticalScrollIntent(),
      cellH,
      rows: term.rows,
      visibleContentHeight,
      cursorBufferRow,
      prevCursorBufferRow,
      cursorInViewport: anchor.cursorInViewport,
      targetScrollTop: anchor.bottomScrollTop,
      currentScrollTop: container.scrollTop,
    });

    if (decision.reason === "intent") {
      // intent=true 期间 (用户主动回看) 完全让出, 同时丢弃 prev 记录, 让回到底部后的下次
      // 光标变动重新进入跟随。否则用户拖回去的轨迹会被记成 prev, 释放 intent 后第一次比对
      // 就误判为"光标变了"而拉一下。
      prevCursorBufferRow = decision.nextPrevCursorBufferRow;
      trace("followCursorY:skip", { details: decision.reason });
      return;
    }
    if (decision.reason === "cellH=0") {
      trace("followCursorY:skip", { details: decision.reason });
      return;
    }
    if (decision.reason === "shortHost") {
      // host 装得下, 几何贴底等于光标可见, 走原路径就行, 不需要 followCursorY 介入。
      // 顺手清 prev 防止下次进入 host>vch 时拿旧 buffer 的行号比对。
      prevCursorBufferRow = decision.nextPrevCursorBufferRow;
      trace("followCursorY:skip", { details: decision.reason });
      return;
    }
    if (decision.reason === "same-row") {
      // 仅 trace 开启时记录 same-row skip, 帮助判断"没跟随"到底是光标未变还是策略阻断。
      // 稳态同名事件会被 scroll trace store 折叠, 不让报告被 render 帧刷爆。
      trace("followCursorY:skip[same-row]", {
        cursorDeltaRows: decision.cursorDeltaRows,
        details: `cursorRow=${cursorBufferRow} same-row`,
      });
      return;
    }
    prevCursorBufferRow = decision.nextPrevCursorBufferRow;
    if (decision.reason === "inViewport") {
      trace("followCursorY:skip", {
        cursorDeltaRows: decision.cursorDeltaRows,
        details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} inViewport`,
      });
      return;
    }
    // anchor.bottomScrollTop 在 long-host 分支里就是把光标行像素居中后的目标 scrollTop。
    if (decision.reason === "aligned") {
      trace("followCursorY:skip", {
        cursorDeltaRows: decision.cursorDeltaRows,
        details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} aligned`,
      });
      return;
    }
    if (decision.action !== "follow") return;
    pendingFollowCursorScrollTop = decision.targetScrollTop;
    const prevScrollTop = container.scrollTop;
    container.scrollTop = decision.targetScrollTop;
    trace("followCursorY:hit", {
      cursorDeltaRows: decision.cursorDeltaRows,
      scrollDeltaToAnchor: prevScrollTop - decision.targetScrollTop,
      details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} scrollTop=${Math.round(prevScrollTop)}->${Math.round(decision.targetScrollTop)}`,
    });
  };

  // 长行场景下光标跟着输入向右移到屏外, 把 scrollLeft 调到能让光标位于视窗中部 (留出
  // 左右上下文)。仅在光标真正出视窗时触发; 用户主动横向滚到光标视窗外后, 通过
  // userHasHorizontalScrollIntent 持续抑制直到用户滚回到光标可见范围。
  const followCursorX = (): void => {
    if (!hasHorizontalOverflow()) {
      clearHorizontalIntentIfUnscrollable("followCursorX");
      return;
    }
    const { cellW } = getDims();
    if (cellW <= 0) return;
    const cursorPxX = term.buffer.active.cursorX * cellW;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    const cursorInViewportX = cursorPxX >= viewportLeft && cursorPxX <= viewportRight;
    if (cursorInViewportX) {
      // 用户滚回到光标可见范围 (或光标自己进了 viewport), 重新 engage 跟踪
      const result = clearPtyHorizontalIntent(horizontalState, {
        details: `site=followCursorX cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
        scrollLeft: container.scrollLeft,
      });
      horizontalState = result.state;
      traceHorizontalIntent(result.trace);
      trace("followCursorX:skip", { details: "cursorInViewport" });
      return;
    }
    if (horizontalState.intent) {
      trace("followCursorX:skip", {
        details: `horizontalIntent cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
      });
      return;
    }
    const target = Math.max(0, cursorPxX - container.clientWidth / 2);
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const pendingFollowLeft = Math.min(maxScrollLeft, target);
    horizontalState = setPtyHorizontalPendingFollow(horizontalState, pendingFollowLeft);
    container.scrollLeft = pendingFollowLeft;
    trace("followCursorX:hit", {
      details: `cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight} target=${pendingFollowLeft}`,
    });
  };

  const onRender = (): void => {
    trace("render");
    updateSpacer();
    // 顺序很关键: retry 必须在 handlePendingNewFrame 之前。如果反过来,
    // handlePendingNewFrame 在 follow 路径里会调 scrollToBottom 改写 scrollTop,
    // 后跑的 syncContainerScroll 就会按"被改写后的 scrollTop"重新对齐,等于无视
    // 用户原本想停留的位置。先 sync 让 user-intent 落地,再 handle pending frame。
    if (pendingContainerSyncRetry) {
      trace("pending-sync-retry-fire");
      syncContainerScroll();
    }
    handlePendingNewFrame();
    followCursorX();
    followCursorY();
    notifyScroll();
  };

  updateSpacer();
  if (userHasVerticalScrollIntent()) {
    notifyScroll();
  } else {
    scrollToBottom("init");
  }

  const onWheel = (event: WheelEvent): void => {
    if (
      hasHorizontalOverflow() &&
      Math.abs(event.deltaX) > 0 &&
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    ) {
      markHorizontalUserInput(`site=wheel deltaX=${event.deltaX}`);
    }
    if (event.deltaY === 0) return;
    trace("wheel:enter");
    event.preventDefault();
    event.stopPropagation();
    scrollByWheelDelta(event.deltaY);
  };

  const domAdapter = attachPtyScrollDomAdapter({
    container,
    term,
    onWheel,
    onTouchStart: touchHandler.onTouchStart,
    onTouchMove: touchHandler.onTouchMove,
    onTouchEnd: touchHandler.onTouchEnd,
    onTouchCancel: touchHandler.onTouchCancel,
    onContainerScroll,
    onTermScroll,
    onRender,
    onRelayout: relayout,
    onWriteParsed: () => {
      bufferRevision += 1;
    },
  });

  const getDebugProbe = (): PtyScrollDebugProbe => {
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    return {
      cellH,
      cellW,
      paddingTop,
      paddingBottom,
      canvasLastY: cellH > 0 && cellW > 0 ? getCachedCanvasLastY() : -1,
      userHasVerticalScrollIntent: userHasVerticalScrollIntent(),
      verticalIntentMode: verticalIntent.mode,
      verticalIntentSource: verticalIntent.source,
      verticalIntentTransitionId: verticalIntent.lastTransitionId,
      userHasHorizontalScrollIntent: horizontalState.intent,
      pendingProgrammaticScrollTop,
      pendingFollowCursorScrollTop,
      pendingFollowCursorScrollLeft: horizontalState.pendingFollowLeft,
      prevCursorBufferRow,
      lastSeenScrollTop,
      lastSeenScrollLeft: horizontalState.lastSeenLeft,
      touchScrollActive: verticalIntent.touchActive,
      touchScrollGestureMode: touchHandler.getState().gestureMode,
      syncingInternal: syncing.internal,
      syncingExternal: syncing.external,
      atBottomThreshold,
      lastSpacerUpdateAt,
      pendingContainerSyncRetry,
    };
  };

  return {
    dispose: () => {
      domAdapter.dispose();
      traceAdapter.dispose();
      cancelPendingTouchScrollNotify();
    },
    relayout,
    scrollToBottom,
    preparePageResumeRestore,
    restorePageResume,
    scrollToRatio,
    scrollToXRatio,
    resetHorizontalScroll,
    markHorizontalScrollIntent,
    traceRawInputFollowScheduled,
    traceRawInputFollowFire,
    getDebugProbe,
  };
}
