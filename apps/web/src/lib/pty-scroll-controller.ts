import type { Terminal } from "@xterm/xterm";
import {
  computeHostTop,
  computePtyHostLayout,
  computeScrollAnchor,
  computeScrollTarget,
  ydispToScrollTop,
} from "./pty-scroll";
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
  // user 最近主动 scroll (wheel / touch / scrollbar drag) 的时间戳。notifyAtBottom
  // 释放 intent 必须落在这个时间窗内, 否则 reconnect 后 layout 重置触发的 transient
  // isAtBottom=true 会错误清掉跨周期保留的回看意图。
  let lastUserScrollAt = -Infinity;
  const USER_SCROLL_INTENT_WINDOW_MS = 250;
  let pendingProgrammaticScrollTop: number | null = null;
  let touchScrollActive = false;
  let touchStartY: number | null = null;
  let touchReviewNotified = false;
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
  // 用户主动横向滚到光标视窗外的意图标记。followCursorX 看到此 flag 时不再 snap 回光标位置;
  // 用户滚回到光标可见范围 (followCursorX 看到光标已 in viewport) 时清掉, 重新 engage 跟踪。
  let userHasHorizontalScrollIntent = false;
  let lastSeenScrollLeft = 0;
  // 进入页面时按"几何贴底"一次定锚 (终端心智), 之后只在"光标行真的变了"时让
  // followCursorY 接管把光标拉回视野。无变动的 onRender 帧 (focus 切换 / theme 重绘 /
  // 同一 buffer 重 paint) 不应改 scrollTop, 否则进入瞬间就会从底吸底跳成 cursor 居中,
  // UX 跳变。null 表示"还没记录过", 等同于"上一帧没看到光标行"。
  let prevCursorBufferRow: number | null = null;

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
      cursorBufferRow: buffer.viewportY + buffer.cursorY,
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
    // 在底 + 仍有 intent + 不在 touch + user 刚刚主动 scroll → 清 intent。
    // 不要求 false → true 过渡: longHost 模式下 isAtBottom = cursorInViewport, 小幅 wheel
    // (光标仍在视野) atBottom 一直是 true, 旧条件 (lastAtBottom === false) 永远不成立,
    // intent 一旦被 wheel set 就清不掉, output 永久 paused。
    // lastUserScrollAt 时间窗守护 reconnect 重建时 layout 误判的 transient atBottom=true,
    // 那种情况没 user 操作不该清掉跨周期保留的回看意图。
    const userJustScrolled = performance.now() - lastUserScrollAt < USER_SCROLL_INTENT_WINDOW_MS;
    if (next && userHasVerticalScrollIntent && !touchScrollActive && userJustScrolled) {
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
      atBottom: getCurrentAnchor().isAtBottom,
      touchActive: touchScrollActive,
      userIntent: userHasVerticalScrollIntent,
      ...extra,
    });
  };

  const positionHostAt = (ydisp: number, cellH: number, visibleContentHeight?: number): void => {
    if (cellH <= 0) return;
    const top = computeHostTop({ ydisp, rows: term.rows, cellH, visibleContentHeight });
    setStyle(host, "position", "absolute");
    setStyle(host, "left", "0px");
    setStyle(host, "top", `${top}px`);
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
    const nextScrollTop = getCurrentAnchor().bottomScrollTop;
    container.scrollTop = nextScrollTop;
    pendingProgrammaticScrollTop = nextScrollTop;
    // 把当前光标行作为基线记下: 紧接其后的 onRender 走 followCursorY 时, prev == current 跳过,
    // 不会把刚刚摆到几何底的视口又拉成 cursor 居中。光标真的"动"了 (claude 重画 / 用户敲)
    // 才让 followCursorY 接管。
    prevCursorBufferRow = term.buffer.active.viewportY + term.buffer.active.cursorY;
    notifyScroll();
    // 清零必须放在最末尾: container.scrollTop = nextScrollTop 会同步触发 onContainerScroll →
    // syncContainerScroll, 此时若 cellH=0 会重新置位 retry flag。开头清零的话这里又会被覆盖,
    // 让 scrollToBottom 的"重置 stale state"语义不真。在所有同步副作用后再清,确保边界干净。
    pendingContainerSyncRetry = false;
    trace("scroll-to-bottom:end", { ydisp: maxYdisp });
  };

  const scrollToRatio = (ratio: number): void => {
    trace("scroll-to-ratio:start");
    lastUserScrollAt = performance.now();
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
    lastUserScrollAt = performance.now();
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
    // 重连或 snapshot 重放时 DOM 尺寸会短暂变化, anchor.isAtBottom 可能误判。
    // 用户已经表达过回看历史时, 以用户意图为准, 避免新输出把视图强行拉到底。
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
    if (ydisp !== buffer.viewportY) {
      scrollToYdisp(ydisp);
    }
    positionHostAt(ydisp, cellH);
    notifyScroll();
    trace("container-sync:end", { ydisp });
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
        userHasHorizontalScrollIntent = true;
      }
      pendingFollowCursorScrollLeft = null;
      lastSeenScrollLeft = container.scrollLeft;
    }
    if (syncing.external) {
      notifyScroll();
      return;
    }
    // followCursorY 自己刚刚程序化设了 scrollTop,不能让本次 scroll 事件被当成"用户回看"
    // 而把 intent 置 true; 也不要走 scrollToBottom 兜底,否则会和 followCursorY 互踩。
    const isPendingFollowCursorScroll =
      pendingFollowCursorScrollTop !== null &&
      Math.abs(container.scrollTop - pendingFollowCursorScrollTop) <= 1;
    if (isPendingFollowCursorScroll) {
      pendingFollowCursorScrollTop = null;
      pendingProgrammaticScrollTop = null;
      notifyScroll();
      return;
    }
    pendingFollowCursorScrollTop = null;
    const atBottom = getCurrentAnchor().isAtBottom;
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
      // 上一次 syncContainerScroll 因 cellH=0 漏掉了 user scroll 时,先按用户当前 scrollTop
      // 把 viewportY 和 host 补齐——再走"按 viewportY 强制对齐 scrollTop"那条路,否则会把
      // 用户的 scrollTop yank 回旧 viewportY 对应位置。
      if (pendingContainerSyncRetry) {
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
    trace("relayout:end");
  };

  // server-owned rows 场景下 host 可能比可视区高, host 内只能看到一段 N 行子窗口。光标
  // 行落在 N 行外就肉眼看不见, 用户只能盲输 (原 bug 现场)。
  // 设计: 进入页面靠 scrollToBottom 几何贴底定锚, followCursorY 只在"光标行真动了"那一帧
  // 把视口拉到光标处。无变动的 onRender 帧 (focus 切换 / theme 重绘 / 同 buffer 重 paint)
  // 不该改 scrollTop, 否则进入瞬间就跳成 cursor 居中, 失去终端"贴底"心智。
  const followCursorY = (): void => {
    if (userHasVerticalScrollIntent) {
      // intent=true 期间 (用户主动回看) 完全让出, 同时丢弃 prev 记录, 让回到底部后的下次
      // 光标变动重新进入跟随。否则用户拖回去的轨迹会被记成 prev, 释放 intent 后第一次比对
      // 就误判为"光标变了"而拉一下。
      prevCursorBufferRow = null;
      return;
    }
    const { cellH } = getDims();
    if (cellH <= 0) return;
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const hostHeight = term.rows * cellH;
    if (hostHeight <= visibleContentHeight) {
      // host 装得下, 几何贴底等于光标可见, 走原路径就行, 不需要 followCursorY 介入。
      // 顺手清 prev 防止下次进入 host>vch 时拿旧 buffer 的行号比对。
      prevCursorBufferRow = null;
      return;
    }
    const buffer = term.buffer.active;
    const cursorBufferRow = buffer.viewportY + buffer.cursorY;
    if (prevCursorBufferRow === cursorBufferRow) return;
    prevCursorBufferRow = cursorBufferRow;
    const anchor = getCurrentAnchor();
    if (anchor.cursorInViewport) return;
    // anchor.bottomScrollTop 在 long-host 分支里就是把光标行像素居中后的目标 scrollTop。
    if (Math.abs(anchor.bottomScrollTop - container.scrollTop) <= 1) return;
    pendingFollowCursorScrollTop = anchor.bottomScrollTop;
    container.scrollTop = anchor.bottomScrollTop;
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
      if (userHasHorizontalScrollIntent) userHasHorizontalScrollIntent = false;
      return;
    }
    if (userHasHorizontalScrollIntent) return;
    const target = Math.max(0, cursorPxX - container.clientWidth / 2);
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    pendingFollowCursorScrollLeft = Math.min(maxScrollLeft, target);
    container.scrollLeft = pendingFollowCursorScrollLeft;
  };

  const onRender = (): void => {
    trace("render");
    updateSpacer();
    // 顺序很关键: retry 必须在 handlePendingNewFrame 之前。如果反过来,
    // handlePendingNewFrame 在 follow 路径里会调 scrollToBottom 改写 scrollTop,
    // 后跑的 syncContainerScroll 就会按"被改写后的 scrollTop"重新对齐,等于无视
    // 用户原本想停留的位置。先 sync 让 user-intent 落地,再 handle pending frame。
    if (pendingContainerSyncRetry) syncContainerScroll();
    handlePendingNewFrame();
    followCursorX();
    followCursorY();
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
    lastUserScrollAt = performance.now();
    setUserHasVerticalScrollIntent(true);
    trace("touchstart");
  };

  const onTouchMove = (event: TouchEvent): void => {
    const currentY = event.touches?.[0]?.clientY ?? null;
    trace("touchmove");
    lastUserScrollAt = performance.now();
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
