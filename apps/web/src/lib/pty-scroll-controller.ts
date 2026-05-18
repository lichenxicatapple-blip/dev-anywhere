import type { Terminal } from "@xterm/xterm";
import {
  computeHostTop,
  computePtyHostLayout,
  computeScrollAnchor,
  computeScrollTarget,
  ydispToScrollTop,
} from "./pty-scroll";
import {
  decideCursorAwareClamp,
  decideScrollToBottomAction,
  decideTouchMoveBoundary,
} from "./pty-follow-policy";
import { appendPtyScrollTrace, isPtyScrollTraceEnabled } from "./pty-scroll-trace";
import {
  canPassiveFollow,
  createInitialPtyVerticalIntentState,
  isReviewing,
  reducePtyVerticalIntent,
  type PtyVerticalIntentEvent,
  type PtyVerticalIntentResult,
} from "./pty-vertical-intent-fsm";
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
  // 浏览器从后台 / bfcache 恢复时可能先还原一个旧 DOM scrollTop。调用方必须传入
  // "页面隐藏前" 的语义状态,而不是恢复后的当前几何状态: 如果隐藏前在 follow,
  // 则旧 scrollTop 是浏览器恢复噪音,需要强制回到底; 如果隐藏前在 review,保持用户位置。
  restorePageResume: (opts: { wasFollowing: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  resetHorizontalScroll: (reason?: string) => void;
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

const RECENT_RAW_INPUT_LAYOUT_DRIFT_MS = 1_000;
const NATIVE_HORIZONTAL_SCROLL_INTENT_THRESHOLD_PX = 48;

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
  let verticalIntent = createInitialPtyVerticalIntentState({
    initialIntent: initialUserHasVerticalScrollIntent,
    scrollTop: container.scrollTop,
  });
  let pendingProgrammaticScrollTop: number | null = null;
  let lastSpacerUpdateAt: number | null = null;
  // cellH=0 时 syncContainerScroll 早返回不能动 host/viewportY,但用户的 scrollTop 已经
  // 改了。这一帧不补,host 会停在旧 ydisp 上,直到下一次显式 user scroll 才会再次走到
  // syncContainerScroll。production blank-render 候选成因之一就是 WebGL canvas 那一帧
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
  let pendingFollowCursorScrollLeft: number | null = null;
  // touch native scroll 可能先把 container 推过 cursor-aware bottom, 再被我们 clamp 回来。
  // touchend 释放回看意图时不能只看最终 scrollTop, 还要知道这次手势是否确实向下到过底部。
  let touchGestureMaxScrollTop: number | null = null;
  let touchStartedAtCursorAwareBottom = false;
  let touchStartClientX: number | null = null;
  let lastTouchClientX: number | null = null;
  let lastTouchClientY: number | null = null;
  // 用户主动横向滚到光标视窗外的意图标记。followCursorX 看到此 flag 时不再 snap 回光标位置;
  // 用户滚回到光标可见范围 (followCursorX 看到光标已 in viewport) 时清掉, 重新 engage 跟踪。
  let userHasHorizontalScrollIntent = false;
  let lastHorizontalUserInputAt: number | null = null;
  let unmarkedHorizontalScrollOriginLeft: number | null = null;
  let lastSeenScrollLeft = 0;
  // 纵向同样需要"用户向下滚到底"的方向判定来释放 intent。longHost 模式下
  // isAtBottom = cursorInViewport, 用户小幅 wheel up 时 cursor 仍可见 → atBottom 仍 true,
  // 仅看 atBottom + 时间窗会把刚 set 的 intent 立刻清掉。改成跟 onContainerScroll 拿到的
  // delta 比对: 只有 scrollTop 真的增大且抵达 atBottom 时才认为用户主动收起回看意图。
  let lastSeenScrollTop = 0;
  // 进入页面时按"几何贴底"一次定锚 (终端心智), 之后只在"光标行真的变了"时让
  // followCursorY 接管把光标拉回视野。无变动的 onRender 帧 (focus 切换 / theme 重绘 /
  // 同一 buffer 重 paint) 不应改 scrollTop, 否则进入瞬间就会从底吸底跳成 cursor 居中,
  // UX 跳变。null 表示"还没记录过", 等同于"上一帧没看到光标行"。
  let prevCursorBufferRow: number | null = null;
  let lastVisualViewportChangeAt: number | null = null;
  let lastRawInputFollowAt: number | null = null;

  const userHasVerticalScrollIntent = (): boolean => isReviewing(verticalIntent);

  const setUserHasHorizontalScrollIntent = (value: boolean, details?: string): void => {
    if (!value) unmarkedHorizontalScrollOriginLeft = null;
    if (userHasHorizontalScrollIntent === value) return;
    userHasHorizontalScrollIntent = value;
    trace(value ? "horizontal-intent:set" : "horizontal-intent:clear", details ? { details } : {});
  };

  const markHorizontalUserInput = (details: string): void => {
    lastHorizontalUserInputAt = performance.now();
    unmarkedHorizontalScrollOriginLeft = null;
    setUserHasHorizontalScrollIntent(true, details);
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

  // focus 字段加细 — 之前只录 aria-label 或 tagName, 用户 trace 里看到 "BUTTON"
  // 不知道是哪个按钮。补 data-slot / id / class 摘要, 让 trace 能直接定位元素。
  const describeFocus = (): string | null => {
    const el = document.activeElement;
    if (!el) return null;
    const aria = el.getAttribute("aria-label") ?? "";
    const tag = el.tagName;
    const slot =
      typeof el.closest === "function"
        ? (el.closest("[data-slot]")?.getAttribute("data-slot") ?? "")
        : "";
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
    const cls =
      typeof el.className === "string" && el.className
        ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : "";
    if (aria) return `${aria}|${tag}${id}${cls}{${slot}}`;
    return `${tag}${id}${cls}{${slot}}`;
  };

  const trace = (
    event: string,
    extra: {
      action?: string;
      reason?: string;
      scope?: string;
      ydisp?: number;
      details?: string;
      cursorDeltaRows?: number | null;
      scrollDeltaToAnchor?: number;
      vvHeightDelta?: number;
      vvOffsetDelta?: number;
    } = {},
  ): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const containerRect = container.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    const anchor = computeScrollAnchor({
      rows: term.rows,
      cellH,
      bufferLength: buffer.length,
      cursorBufferRow,
      visibleContentHeight,
      paddingTop,
      paddingBottom,
      containerScrollTop: container.scrollTop,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      atBottomThreshold,
    });
    const defaultCursorDeltaRows =
      prevCursorBufferRow === null ? null : cursorBufferRow - prevCursorBufferRow;
    const cursorDeltaRows =
      extra.cursorDeltaRows !== undefined ? extra.cursorDeltaRows : defaultCursorDeltaRows;
    const scrollDeltaToAnchor =
      extra.scrollDeltaToAnchor !== undefined
        ? extra.scrollDeltaToAnchor
        : container.scrollTop - anchor.bottomScrollTop;
    const currentHostTop = parsePx(host.style.top);
    const expectedHostTop =
      cellH > 0
        ? computeHostTop({
            ydisp: buffer.viewportY,
            rows: term.rows,
            cellH,
            visibleContentHeight,
          })
        : 0;
    const currentHostHeight = parsePx(host.style.height);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const hostBottom = currentHostTop + currentHostHeight;
    const hostOverlap = Math.max(
      0,
      Math.min(viewportBottom, hostBottom) - Math.max(viewportTop, currentHostTop),
    );
    appendPtyScrollTrace({
      t: performance.now(),
      event,
      scope: extra.scope,
      action: extra.action,
      reason: extra.reason,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      scrollHeight: container.scrollHeight,
      scrollWidth: container.scrollWidth,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
      innerHeight: window.innerHeight,
      visualViewportHeight: visualViewport?.height,
      visualViewportOffsetTop: visualViewport?.offsetTop,
      containerTop: containerRect.top,
      containerBottom: containerRect.bottom,
      hostRectTop: hostRect.top,
      hostRectBottom: hostRect.bottom,
      viewportY: buffer.viewportY,
      bufferLength: buffer.length,
      hostTop: host.style.top,
      cellH,
      cellW,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      cursorBufferRow,
      cursorDeltaRows,
      cursorInViewport: anchor.cursorInViewport,
      anchorBottomScrollTop: anchor.bottomScrollTop,
      scrollDeltaToAnchor,
      pendingProgrammaticScrollTop,
      pendingFollowCursorScrollTop,
      pendingFollowCursorScrollLeft,
      pendingContainerSyncRetry,
      horizontalIntent: userHasHorizontalScrollIntent,
      intentMode: verticalIntent.mode,
      intentSource: verticalIntent.source,
      intentTransition: verticalIntent.lastTransitionId,
      prevCursorBufferRow,
      hostTopDrift: currentHostTop - expectedHostTop,
      viewportHostCoverage: container.clientHeight > 0 ? hostOverlap / container.clientHeight : 0,
      focus: describeFocus(),
      atBottom: anchor.isAtBottom,
      touchActive: verticalIntent.touchActive,
      userIntent: userHasVerticalScrollIntent(),
      ...extra,
    });
  };

  const traceRawInputFollowScheduled = (source: string = "rawInput"): void => {
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
    const top = computeHostTop({ ydisp, rows: term.rows, cellH, visibleContentHeight });
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

  const restorePageResume = ({ wasFollowing }: { wasFollowing: boolean }): void => {
    if (!wasFollowing) {
      trace("page-resume:preserve-review");
      notifyScroll();
      return;
    }
    updateSpacer();
    scrollToBottom("pageResume", { force: true });
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
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const clamped = Math.max(0, Math.min(1, ratio));
    container.scrollLeft = maxScrollLeft * clamped;
    markHorizontalUserInput(`site=scrollToXRatio ratio=${clamped}`);
    lastSeenScrollLeft = container.scrollLeft;
    notifyScroll();
  };

  const resetHorizontalScroll = (reason: string = "external"): void => {
    const previous = container.scrollLeft;
    lastHorizontalUserInputAt = null;
    unmarkedHorizontalScrollOriginLeft = null;
    pendingFollowCursorScrollLeft = null;
    setUserHasHorizontalScrollIntent(false, `site=resetHorizontalScroll reason=${reason}`);
    if (previous !== 0) {
      container.scrollLeft = 0;
    }
    lastSeenScrollLeft = container.scrollLeft;
    trace(`horizontal-scroll-reset[${reason}]`, {
      details: `scrollLeft=${previous}->${container.scrollLeft}`,
    });
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
      positionHostAt(ydisp, cellH);
      return;
    }

    syncing.internal = true;
    try {
      if (opts.deferHostUntilRender) {
        term.scrollToLine(ydisp);
        return;
      }
      // Non-touch callers still keep host geometry ahead of xterm's synchronous onScroll
      // observers. Native touch scroll is different: the compositor has already moved the
      // scroll container, so moving host.top before xterm paints the new row exposes a
      // one-row visual jump. Those callers defer host positioning until onRender.
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

  const syncContainerScroll = (opts: { deferHostUntilRender?: boolean } = {}): void => {
    trace("container-sync:start");
    const { cellH } = getDims();
    if (cellH === 0) {
      // canvas 还没 measure 到 / WebGL context 暂失效。先记下,等 onRender / relayout 补。
      pendingContainerSyncRetry = true;
      return;
    }
    pendingContainerSyncRetry = false;
    const buffer = term.buffer.active;
    const { ydisp } = computeScrollTarget(container.scrollTop, {
      bufferLength: buffer.length,
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
      cellH,
      cellW: 1,
    });
    syncViewportAndHostAt(ydisp, cellH, opts);
    notifyScroll();
    trace("container-sync:end", { ydisp });
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

  const restoreStationaryTouchLayoutShift = (effectiveScrollTop: number): boolean => {
    const touchStartScrollTop = verticalIntent.touchStartScrollTop;
    if (!verticalIntent.touchActive || verticalIntent.touchReviewNotified) return false;
    if (touchStartScrollTop === null) return false;

    const { cellH } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const longHost = cellH > 0 && term.rows * cellH > visibleContentHeight;
    const recentVisualViewportChange =
      lastVisualViewportChangeAt !== null && performance.now() - lastVisualViewportChangeAt <= 500;
    if (!longHost && !recentVisualViewportChange) return false;

    const anchor = getCurrentAnchor();
    const touchMaxScrollTop = touchGestureMaxScrollTop ?? touchStartScrollTop;
    const startedAtCursorAwareBottom =
      Math.max(touchStartScrollTop, touchMaxScrollTop) >=
      anchor.bottomScrollTop - atBottomThreshold;
    const jumpedAwayFromTouchStart = effectiveScrollTop < touchStartScrollTop - atBottomThreshold;
    const jumpedAwayFromCurrentBottom =
      effectiveScrollTop < anchor.bottomScrollTop - atBottomThreshold;
    if (!startedAtCursorAwareBottom || !jumpedAwayFromTouchStart || !jumpedAwayFromCurrentBottom) {
      return false;
    }

    trace("container-scroll:restore-touch-layout-bottom", {
      details: `scrollTop=${effectiveScrollTop} bottom=${anchor.bottomScrollTop} touchStart=${touchStartScrollTop}`,
    });
    container.scrollTop = anchor.bottomScrollTop;
    lastSeenScrollTop = anchor.bottomScrollTop;
    touchGestureMaxScrollTop = Math.max(touchMaxScrollTop, anchor.bottomScrollTop);
    syncContainerScroll();
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
      performance.now() - lastRawInputFollowAt <= RECENT_RAW_INPUT_LAYOUT_DRIFT_MS;
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

  const preventTouchMovePastCursorAwareBottom = (
    event: TouchEvent,
    currentX: number | null,
    currentY: number | null,
  ): void => {
    const previousX = lastTouchClientX;
    const previousY = lastTouchClientY;
    lastTouchClientX = currentX;
    lastTouchClientY = currentY;
    // On touch screens, finger-up means content scrollTop increases. At cursor-aware
    // bottom this native scroll has no useful terminal state to expose; letting it
    // happen creates an 8px compositor bounce that the next render then snaps back.
    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const anchor = getCurrentAnchor();
    const decision = decideTouchMoveBoundary({
      previousClientX: previousX,
      currentClientX: currentX,
      previousClientY: previousY,
      currentClientY: currentY,
      scrollTop: container.scrollTop,
      bottomScrollTop: anchor.bottomScrollTop,
      domMaxScrollTop,
      atBottom: anchor.isAtBottom,
    });
    if (decision.action === "allow") return;

    if (
      decision.scrollTop !== undefined &&
      Math.abs(container.scrollTop - decision.scrollTop) > 1
    ) {
      container.scrollTop = decision.scrollTop;
      pendingProgrammaticScrollTop = null;
      pendingFollowCursorScrollTop = null;
      syncContainerScroll();
    }

    onTouchBoundaryPrevent?.();
    touchGestureMaxScrollTop = Math.max(
      touchGestureMaxScrollTop ?? container.scrollTop,
      decision.scrollTop ?? anchor.bottomScrollTop,
    );
    if (event.cancelable) {
      event.preventDefault();
    }
    trace("touchmove:prevent-cursor-bottom", {
      details: `scrollTop=${container.scrollTop} bottom=${anchor.bottomScrollTop} domMax=${domMaxScrollTop}`,
    });
  };

  const onContainerScroll = (): void => {
    trace("container-scroll");
    // 横向 scroll 意图检测: 跟 followCursorX 的程序化写入区分。我们刚改 scrollLeft
    // 不算 user intent; 其它路径下 scrollLeft 与上次记录不同 → 视为用户主动横向滚动。
    const horizontalChanged = container.scrollLeft !== lastSeenScrollLeft;
    if (horizontalChanged) {
      const isPendingFollowCursorScrollLeft =
        pendingFollowCursorScrollLeft !== null &&
        Math.abs(container.scrollLeft - pendingFollowCursorScrollLeft) <= 1;
      if (!isPendingFollowCursorScrollLeft) {
        const hasRecentHorizontalUserInput =
          lastHorizontalUserInputAt !== null &&
          performance.now() - lastHorizontalUserInputAt <= 500;
        if (hasRecentHorizontalUserInput) {
          unmarkedHorizontalScrollOriginLeft = null;
          setUserHasHorizontalScrollIntent(
            true,
            `site=onContainerScroll prev=${lastSeenScrollLeft} next=${container.scrollLeft}`,
          );
        } else {
          const origin =
            unmarkedHorizontalScrollOriginLeft === null
              ? lastSeenScrollLeft
              : unmarkedHorizontalScrollOriginLeft;
          unmarkedHorizontalScrollOriginLeft = origin;
          const nativeDelta = Math.abs(container.scrollLeft - origin);
          if (nativeDelta >= NATIVE_HORIZONTAL_SCROLL_INTENT_THRESHOLD_PX) {
            setUserHasHorizontalScrollIntent(
              true,
              `site=onContainerScroll-native prev=${origin} next=${container.scrollLeft} delta=${nativeDelta}`,
            );
            unmarkedHorizontalScrollOriginLeft = null;
          } else {
            trace("horizontal-intent:ignore", {
              details: `site=onContainerScroll prev=${lastSeenScrollLeft} next=${container.scrollLeft} nativeDelta=${nativeDelta}`,
            });
          }
        }
      } else {
        unmarkedHorizontalScrollOriginLeft = null;
      }
      pendingFollowCursorScrollLeft = null;
      lastSeenScrollLeft = container.scrollLeft;
    }
    // 纵向 delta: 区分用户主动向下滚 vs 向上滚, 用于 intent 释放方向判定。每条
    // scroll 事件都更新 lastSeen, 程序化与用户路径共用。
    const rawScrollTop = container.scrollTop;
    const verticalDelta = rawScrollTop - lastSeenScrollTop;
    if (verticalIntent.touchActive) {
      touchGestureMaxScrollTop = Math.max(touchGestureMaxScrollTop ?? rawScrollTop, rawScrollTop);
    }
    const effectiveScrollTop = clampCursorAwareBottomOverscroll(rawScrollTop);
    lastSeenScrollTop = effectiveScrollTop;
    if (syncing.external) {
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
    const isPendingFollowCursorScroll =
      pendingFollowCursorScrollTop !== null &&
      Math.abs(effectiveScrollTop - pendingFollowCursorScrollTop) <= 1;
    if (isPendingFollowCursorScroll) {
      pendingFollowCursorScrollTop = null;
      pendingProgrammaticScrollTop = null;
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
    pendingFollowCursorScrollTop = null;
    const atBottom = getCurrentAnchor().isAtBottom;
    const isPendingProgrammaticScroll =
      pendingProgrammaticScrollTop !== null &&
      Math.abs(effectiveScrollTop - pendingProgrammaticScrollTop) <= 1 &&
      canPassiveFollow(verticalIntent);
    if (!atBottom && isPendingProgrammaticScroll) {
      pendingProgrammaticScrollTop = null;
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
    pendingProgrammaticScrollTop = null;
    if (restoreStationaryTouchLayoutShift(effectiveScrollTop)) {
      return;
    }
    if (restoreRecentRawInputLayoutDrift(effectiveScrollTop, atBottom, verticalDelta)) {
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
    syncContainerScroll({ deferHostUntilRender: verticalIntent.touchActive });
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
        container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
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
    if (userHasVerticalScrollIntent()) {
      // intent=true 期间 (用户主动回看) 完全让出, 同时丢弃 prev 记录, 让回到底部后的下次
      // 光标变动重新进入跟随。否则用户拖回去的轨迹会被记成 prev, 释放 intent 后第一次比对
      // 就误判为"光标变了"而拉一下。
      prevCursorBufferRow = null;
      trace("followCursorY:skip", { details: "intent" });
      return;
    }
    const { cellH } = getDims();
    if (cellH <= 0) {
      trace("followCursorY:skip", { details: "cellH=0" });
      return;
    }
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const hostHeight = term.rows * cellH;
    if (hostHeight <= visibleContentHeight) {
      // host 装得下, 几何贴底等于光标可见, 走原路径就行, 不需要 followCursorY 介入。
      // 顺手清 prev 防止下次进入 host>vch 时拿旧 buffer 的行号比对。
      prevCursorBufferRow = null;
      trace("followCursorY:skip", { details: "shortHost" });
      return;
    }
    const buffer = term.buffer.active;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    const prevRow = prevCursorBufferRow;
    const cursorDeltaRows = prevRow === null ? null : cursorBufferRow - prevRow;
    const anchor = getCurrentAnchor();
    if (prevCursorBufferRow === cursorBufferRow && anchor.cursorInViewport) {
      // 仅 trace 开启时记录 same-row skip, 帮助判断"没跟随"到底是光标未变还是策略阻断。
      // 稳态同名事件会被 scroll trace store 折叠, 不让报告被 render 帧刷爆。
      trace("followCursorY:skip[same-row]", {
        cursorDeltaRows: 0,
        details: `cursorRow=${cursorBufferRow} same-row`,
      });
      return;
    }
    prevCursorBufferRow = cursorBufferRow;
    if (anchor.cursorInViewport) {
      trace("followCursorY:skip", {
        cursorDeltaRows,
        details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} inViewport`,
      });
      return;
    }
    // anchor.bottomScrollTop 在 long-host 分支里就是把光标行像素居中后的目标 scrollTop。
    if (Math.abs(anchor.bottomScrollTop - container.scrollTop) <= 1) {
      trace("followCursorY:skip", {
        cursorDeltaRows,
        details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} aligned`,
      });
      return;
    }
    pendingFollowCursorScrollTop = anchor.bottomScrollTop;
    const prevScrollTop = container.scrollTop;
    container.scrollTop = anchor.bottomScrollTop;
    trace("followCursorY:hit", {
      cursorDeltaRows,
      scrollDeltaToAnchor: prevScrollTop - anchor.bottomScrollTop,
      details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} scrollTop=${Math.round(prevScrollTop)}->${Math.round(anchor.bottomScrollTop)}`,
    });
  };

  // 长行场景下光标跟着输入向右移到屏外, 把 scrollLeft 调到能让光标位于视窗中部 (留出
  // 左右上下文)。仅在光标真正出视窗时触发; 用户主动横向滚到光标视窗外后, 通过
  // userHasHorizontalScrollIntent 持续抑制直到用户滚回到光标可见范围。
  const followCursorX = (): void => {
    if (container.scrollWidth <= container.clientWidth) return;
    const { cellW } = getDims();
    if (cellW <= 0) return;
    const cursorPxX = term.buffer.active.cursorX * cellW;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    const cursorInViewportX = cursorPxX >= viewportLeft && cursorPxX <= viewportRight;
    if (cursorInViewportX) {
      // 用户滚回到光标可见范围 (或光标自己进了 viewport), 重新 engage 跟踪
      setUserHasHorizontalScrollIntent(
        false,
        `site=followCursorX cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
      );
      trace("followCursorX:skip", { details: "cursorInViewport" });
      return;
    }
    if (userHasHorizontalScrollIntent) {
      trace("followCursorX:skip", {
        details: `horizontalIntent cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
      });
      return;
    }
    const target = Math.max(0, cursorPxX - container.clientWidth / 2);
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    pendingFollowCursorScrollLeft = Math.min(maxScrollLeft, target);
    container.scrollLeft = pendingFollowCursorScrollLeft;
    trace("followCursorX:hit", {
      details: `cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight} target=${pendingFollowCursorScrollLeft}`,
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
    if (Math.abs(event.deltaX) > 0 && Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      markHorizontalUserInput(`site=wheel deltaX=${event.deltaX}`);
    }
    if (event.deltaY === 0) return;
    trace("wheel:enter");
    event.preventDefault();
    event.stopPropagation();
    scrollByWheelDelta(event.deltaY);
  };

  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches?.[0] ?? null;
    const startX = touch?.clientX ?? null;
    const startY = touch?.clientY ?? null;
    touchGestureMaxScrollTop = container.scrollTop;
    touchStartedAtCursorAwareBottom = getCurrentAnchor().isAtBottom;
    touchStartClientX = startX;
    lastTouchClientX = startX;
    lastTouchClientY = startY;
    dispatchVerticalIntent({
      type: "touch-start",
      clientY: startY,
      scrollTop: container.scrollTop,
    });
    trace("touchstart");
  };

  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches?.[0] ?? null;
    const currentX = touch?.clientX ?? null;
    const currentY = touch?.clientY ?? null;
    trace("touchmove");
    if (
      touchStartClientX !== null &&
      verticalIntent.touchStartY !== null &&
      currentX !== null &&
      currentY !== null
    ) {
      const dx = Math.abs(currentX - touchStartClientX);
      const dy = Math.abs(currentY - verticalIntent.touchStartY);
      if (dx >= 8 && dx > dy) {
        markHorizontalUserInput(`site=touchmove dx=${dx} dy=${dy}`);
      }
    }
    preventTouchMovePastCursorAwareBottom(event, currentX, currentY);
    const result = dispatchVerticalIntent({
      type: "touch-move",
      clientY: currentY,
      reviewThresholdPx: 8,
    });
    if (result.notifyTouchReviewStart) trace("touchmove:review");
  };

  const finishTouchGesture = (type: "touch-end" | "touch-cancel"): void => {
    // 触摸结束时, 若 touchstart→touchend 净位移为向下且抵达 atBottom, 释放 intent。
    // onContainerScroll 的 touchActive 期间不释放, 由 FSM 在 touch end/cancel 统一判定。
    const touchStartScrollTop = verticalIntent.touchStartScrollTop;
    const liveScrollTop = container.scrollTop;
    const anchor = getCurrentAnchor();
    const stayedNearTouchStart =
      touchStartScrollTop === null || liveScrollTop >= touchStartScrollTop - atBottomThreshold;
    const releaseOnSemanticBottom = touchStartedAtCursorAwareBottom && anchor.isAtBottom;
    const atCursorAwareBottomForIntent =
      anchor.isAtBottom ||
      (touchStartedAtCursorAwareBottom &&
        !verticalIntent.touchReviewNotified &&
        stayedNearTouchStart);
    touchGestureMaxScrollTop = null;
    touchStartedAtCursorAwareBottom = false;
    touchStartClientX = null;
    lastTouchClientX = null;
    lastTouchClientY = null;
    dispatchVerticalIntent({
      type,
      scrollTop: liveScrollTop,
      atCursorAwareBottom: atCursorAwareBottomForIntent,
      releaseOnSemanticBottom,
    });
    notifyAtBottom();
  };

  const onTouchEnd = (): void => {
    finishTouchGesture("touch-end");
    trace("touchend");
  };

  const onTouchCancel = (): void => {
    // iOS momentum scroll 被 visualViewport 重排打断 / 系统手势接管时 fire。
    // touchend 永远不会再来, 必须按 touchend 同等清理 intent / state。
    finishTouchGesture("touch-cancel");
    trace("touchcancel");
  };

  container.addEventListener("wheel", onWheel, { passive: false, capture: true });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchCancel, { passive: true });
  container.addEventListener("scroll", onContainerScroll, { passive: true });

  // visualViewport 软键盘 / iOS Safari 地址栏收合 / 缩放等会改 vv.height / offsetTop, 触发
  // 容器 reflow + xterm onRender; 没独立 trace 时只能在别的事件里捎带快照, 看不出 reflow 边界。
  // 移动端文本上下抖动嫌疑路径: vv:resize/scroll → onRender → followCursorY 串起来。
  let prevVvHeight: number | null = null;
  let prevVvOffsetTop: number | null = null;
  const onVvResize = (): void => {
    lastVisualViewportChangeAt = performance.now();
    restoreStationaryTouchLayoutShift(container.scrollTop);
    if (!isPtyScrollTraceEnabled()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const dh = prevVvHeight === null ? 0 : vv.height - prevVvHeight;
    const dy = prevVvOffsetTop === null ? 0 : vv.offsetTop - prevVvOffsetTop;
    prevVvHeight = vv.height;
    prevVvOffsetTop = vv.offsetTop;
    trace("vv:resize", { vvHeightDelta: dh, vvOffsetDelta: dy });
  };
  const onVvScroll = (): void => {
    lastVisualViewportChangeAt = performance.now();
    restoreStationaryTouchLayoutShift(container.scrollTop);
    if (!isPtyScrollTraceEnabled()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const dh = prevVvHeight === null ? 0 : vv.height - prevVvHeight;
    const dy = prevVvOffsetTop === null ? 0 : vv.offsetTop - prevVvOffsetTop;
    prevVvHeight = vv.height;
    prevVvOffsetTop = vv.offsetTop;
    trace("vv:scroll", { vvHeightDelta: dh, vvOffsetDelta: dy });
  };
  window.visualViewport?.addEventListener("resize", onVvResize);
  window.visualViewport?.addEventListener("scroll", onVvScroll);

  // window 级 wheel sniffer (capture-phase): 不论 wheel 是否能到 container, 都能看到
  // 事件确实发生 + 目标是哪个元素 + 谁先 preventDefault 了。trace 里区分两种"看不到 wheel"的
  // 情形 — (a) 用户根本没滚 vs (b) 滚了但 button / popover 等吃掉了。仅诊断用,
  // 不修改任何控制流; 只在 trace 启用时录入。
  const onWindowWheelSniff = (event: WheelEvent): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const target = event.target as Element | null;
    const reachesContainer =
      target === container || (target instanceof Node && container.contains(target));
    const targetSlot =
      target && typeof target.closest === "function"
        ? (target.closest("[data-slot]")?.getAttribute("data-slot") ?? "")
        : "";
    const targetTag = target?.tagName ?? "";
    const targetCls =
      target && typeof (target as Element).className === "string" && (target as Element).className
        ? "." +
          ((target as Element).className as string)
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join(".")
        : "";
    trace(
      `wheel:window deltaY=${Math.round(event.deltaY)} reachesContainer=${reachesContainer ? 1 : 0} prevented=${event.defaultPrevented ? 1 : 0} target=${targetTag}${targetCls}{${targetSlot}}`,
    );
  };
  window.addEventListener("wheel", onWindowWheelSniff, { passive: true, capture: true });
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
      userHasVerticalScrollIntent: userHasVerticalScrollIntent(),
      verticalIntentMode: verticalIntent.mode,
      verticalIntentSource: verticalIntent.source,
      verticalIntentTransitionId: verticalIntent.lastTransitionId,
      userHasHorizontalScrollIntent,
      pendingProgrammaticScrollTop,
      pendingFollowCursorScrollTop,
      pendingFollowCursorScrollLeft,
      prevCursorBufferRow,
      lastSeenScrollTop,
      lastSeenScrollLeft,
      touchScrollActive: verticalIntent.touchActive,
      syncingInternal: syncing.internal,
      syncingExternal: syncing.external,
      atBottomThreshold,
      lastSpacerUpdateAt,
      pendingContainerSyncRetry,
    };
  };

  return {
    dispose: () => {
      container.removeEventListener("scroll", onContainerScroll);
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("wheel", onWindowWheelSniff, { capture: true });
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      dispScroll.dispose();
      dispRender.dispose();
      dispWriteParsed?.dispose();
      ro.disconnect();
    },
    relayout,
    scrollToBottom,
    restorePageResume,
    scrollToRatio,
    scrollToXRatio,
    resetHorizontalScroll,
    traceRawInputFollowScheduled,
    traceRawInputFollowFire,
    getDebugProbe,
  };
}
