import type { IMarker, Terminal } from "@xterm/xterm";
import {
  computeHostTop,
  computePtyHostLayout,
  computePtyLiveBackfill,
  computePtyLiveViewportBridge,
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
import {
  decideCursorAwareClamp,
  decideScrollToBottomAction,
  resolvePtyNativeScrollMax,
  shouldWheelCommitPtySemanticBottom,
} from "./pty-follow-policy";
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
import type { PtyHistoryProjection } from "./pty-history-projection";
import { parsePx } from "./pty-style-utils";
import { createPtyStyleWriter } from "./pty-style-writer";
import { createPtyTouchScrollHandler } from "./pty-touch-scroll-handler";
import { findLiveScreenLastNonEmptyRow, measureXtermCellSize } from "./pty-xterm-metrics";

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
  onHistoryProjectionChange?: (projection: PtyHistoryProjection | null) => boolean;
  getBufferRowIdentityOffset?: () => number;
  atBottomThreshold?: number;
}

interface PtyLiveFrameSnapshot {
  cellH: number;
  visibleContentHeight: number;
  viewportY: number;
  cursorBufferRow: number;
  anchor: ReturnType<typeof computeScrollAnchor>;
}

interface PtyLiveReviewAnchor {
  marker: IMarker;
  fractionalRowOffset: number;
  lastLine: number;
  rowIdentityOffset: number;
  scrollTopAtCapture: number;
}

interface PtyVerticalFramePlan {
  viewportY: number;
  scrollTop: number;
  cellH: number;
  visibleContentHeight?: number;
}

interface PtyLiveFramePlan extends PtyVerticalFramePlan {
  cursorBufferRow: number;
}

type PtyLiveFrameScrollOwner = "programmatic-bottom" | "follow-cursor";

interface PtyScrollController {
  dispose: () => void;
  relayout: () => void;
  // reason 是 trace label, 让用户报回的 trace 能区分哪条外部路径触发了 scrollToBottom
  // (rawInput / backToBottomButton / 内部 follow / init / ...)。opts.force=true 是
  // 用户明示动作 (BackToBottom 按钮 / init / 修 stale state) 才能压过 userIntent;
  // 默认被动 caller (pendingFrame / relayout / termScroll) 在 intent=true
  // 时整段 no-op。把 invariant 收到 controller 内部, 新加 caller 默认就对。
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  // 浏览器从后台 / bfcache 恢复时可能回放旧 DOM 坐标。生命周期恢复不保存像素或
  // buffer 行；重新激活统一回到当前 live tail，避免旧 buffer 坐标污染新终端。
  preparePageResumeRestore: () => void;
  restorePageResume: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  resetHorizontalScroll: (reason?: string, opts?: { holdUntilCursorVisible?: boolean }) => void;
  markSelectionAutoscrollIntent: (reason?: string) => void;
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

type PendingFrameResult = "none" | "deferred" | "followed" | "marked";

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
    onHistoryProjectionChange,
    getBufferRowIdentityOffset = () => 0,
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
  // followCursorY 主动改写 scrollTop 后,容器 scroll 事件仍需知道这次写入属于哪一个
  // controller transaction。否则 bare-scroll 的 canonical follow 会接管并把 cursor-follow
  // 目标覆盖成 semantic bottom。这个 mark 只做来源归属,不保存第二份滚动位置真相。
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
  // 页面从后台 / keepalive 隐藏层恢复时，浏览器可能先回放旧 scrollTop / scrollLeft。
  // 这段生命周期没有用户输入所有权；恢复完成前忽略 DOM 回放，激活后统一回 live tail。
  let pageResumeRestorePending = false;
  // 进入页面时按"几何贴底"一次定锚 (终端心智), 之后只在"光标行真的变了"时让
  // followCursorY 接管把光标拉回视野。无变动的 onRender 帧 (focus 切换 / theme 重绘 /
  // 同一 buffer 重 paint) 不应改 scrollTop, 否则进入瞬间就会从底吸底跳成 cursor 居中,
  // UX 跳变。null 表示"还没记录过", 等同于"上一帧没看到光标行"。
  let prevCursorBufferRow: number | null = null;
  let pendingTouchScrollNotifyFrame: number | null = null;
  let pendingTouchScrollNotifyCancel: ((handle: number) => void) | null = null;
  // xterm can synchronously emit thousands of onScroll events while parsing an authoritative
  // snapshot. The terminal buffer remains xterm-owned; only the derived DOM/review/follow
  // reconciliation is coalesced. Reading terminal state when this frame fires makes the last
  // event in the parser burst authoritative and leaves the final repair queued before the next
  // browser paint (the RAF is requested from inside the first synchronous onScroll callback).
  let pendingTermScrollReconcileFrame: number | null = null;
  let pendingTermScrollReconcileCancel: ((handle: number) => void) | null = null;
  let disposed = false;
  let activeHistoryProjection: {
    kind: PtyHistoryProjection["kind"];
    key: string;
  } | null = null;
  let liveReviewAnchor: PtyLiveReviewAnchor | null = null;
  // `term.buffer.active.viewportY` changes synchronously, while xterm's DOM rows paint on its next
  // render frame. Keep the last host/DOM coordinate explicit so a native compositor scroll can
  // bridge that interval without moving old glyphs to new buffer coordinates.
  let positionedHostYdisp: number | null = null;
  let deferredViewportPaintPending = false;
  let activeBufferType = term.buffer.active.type;
  let bufferBoundaryReconcileQueued = false;
  let bufferBoundaryCrossedType = false;
  // A same-type normal reset can be followed by an authoritative snapshot write in a later task.
  // xterm parses that snapshot with user-scrolling reset to false, so it may advance viewportY to
  // the tail again. Re-assert the replacement row-0 review anchor at onWriteParsed, before the
  // renderer's RAF gets a chance to expose that tail for one frame.
  let sameTypeReviewBoundaryAwaitingWrite = false;

  const userHasVerticalScrollIntent = (): boolean => isReviewing(verticalIntent);

  const traceAdapter = createPtyScrollTraceAdapter({
    container,
    host,
    term,
    atBottomThreshold,
    getDims,
    getVerticalInsets,
    getLiveLastY: () => getCachedLiveLastY(),
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

  const cancelPendingPageResumeRestore = (reason: string): void => {
    if (!pageResumeRestorePending) return;
    trace("page-resume:cancel", {
      details: `reason=${reason}`,
    });
    pageResumeRestorePending = false;
  };

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
    cancelPendingPageResumeRestore(`horizontal:${details}`);
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

  // Read every value that defines one live frame before any DOM/xterm write. Callers that commit
  // a frame must keep this snapshot intact instead of recomputing the target halfway through the
  // write sequence, when viewportY and host.top may already describe different rows.
  const readLiveFrameSnapshot = (): PtyLiveFrameSnapshot => {
    const { cellH } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const buffer = term.buffer.active;
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    const anchor = computeScrollAnchor({
      rows: term.rows,
      cellH,
      bufferLength: buffer.length,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorBufferRow,
      liveLastY: getCachedLiveLastY(),
      visibleContentHeight,
      paddingTop,
      paddingBottom,
      hostPaddingTop: parsePx(host.style.paddingTop),
      containerScrollTop: container.scrollTop,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      atBottomThreshold,
    });
    return {
      cellH,
      visibleContentHeight,
      viewportY: buffer.viewportY,
      cursorBufferRow,
      anchor,
    };
  };

  const getCurrentAnchor = (): ReturnType<typeof computeScrollAnchor> =>
    readLiveFrameSnapshot().anchor;

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
    trace(`rawInputFollow:scheduled[${source}]`);
  };

  const traceRawInputFollowFire = (): void => {
    trace("rawInputFollow:fire");
  };

  const clearLiveReviewAnchor = (): void => {
    liveReviewAnchor?.marker.dispose();
    liveReviewAnchor = null;
  };

  const readReviewGeometry = (cellH: number) => {
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const geometryOrigin = computeHostTop({
      ydisp: 0,
      rows: term.rows,
      cellH,
      visibleContentHeight,
    });
    return { geometryOrigin, visibleContentHeight };
  };

  const captureLiveReviewAnchor = (): void => {
    if (!userHasVerticalScrollIntent()) {
      clearLiveReviewAnchor();
      return;
    }
    const { cellH } = getDims();
    const buffer = term.buffer.active;
    if (
      cellH <= 0 ||
      buffer.length <= 0 ||
      (buffer as typeof buffer & { type?: "normal" | "alternate" }).type === "alternate"
    ) {
      clearLiveReviewAnchor();
      return;
    }
    const { geometryOrigin } = readReviewGeometry(cellH);
    const logicalTop = Math.max(0, (container.scrollTop - geometryOrigin) / cellH);
    const clampedLogicalTop = Math.min(buffer.length - 1, logicalTop);
    const row = Math.floor(clampedLogicalTop);
    const cursorRow = buffer.baseY + buffer.cursorY;
    const marker = term.registerMarker(row - cursorRow);
    clearLiveReviewAnchor();
    liveReviewAnchor = {
      marker,
      fractionalRowOffset: clampedLogicalTop - row,
      lastLine: marker.line,
      rowIdentityOffset: getBufferRowIdentityOffset(),
      scrollTopAtCapture: container.scrollTop,
    };
  };

  const reconcileLiveReviewAnchor = (
    cellH: number,
    options: { includeDomDelta?: boolean } = {},
  ): void => {
    if (!userHasVerticalScrollIntent() || cellH <= 0) return;
    const buffer = term.buffer.active;
    if ((buffer as typeof buffer & { type?: "normal" | "alternate" }).type === "alternate") {
      clearLiveReviewAnchor();
      return;
    }
    const anchor = liveReviewAnchor;
    if (!anchor) {
      captureLiveReviewAnchor();
      return;
    }

    const { geometryOrigin, visibleContentHeight } = readReviewGeometry(cellH);
    const currentRowIdentityOffset = getBufferRowIdentityOffset();
    const rowIdentityDelta = currentRowIdentityOffset - anchor.rowIdentityOffset;
    const markerDisposed = anchor.marker.isDisposed || anchor.marker.line < 0;
    const resolvedLine = Math.max(
      0,
      Math.min(
        Math.max(0, buffer.length - 1),
        markerDisposed ? anchor.lastLine + Math.min(0, rowIdentityDelta) : anchor.marker.line,
      ),
    );
    const userDelta = options.includeDomDelta ? container.scrollTop - anchor.scrollTopAtCapture : 0;

    const desiredScrollTop = Math.max(
      0,
      geometryOrigin + (resolvedLine + anchor.fractionalRowOffset) * cellH + userDelta,
    );
    if (Math.abs(container.scrollTop - desiredScrollTop) > 0.5) {
      // xterm has already rebased its viewport for a trim. Move the outer native scroller by the
      // same row delta before paint so the same buffer content stays under the reader's finger.
      // When a compositor-owned gesture landed in the same frame, `userDelta` keeps that physical
      // movement on top of the row-identity correction instead of letting either side win.
      if (deferredViewportPaintPending) {
        syncTransientViewportBridge(
          positionedHostYdisp ?? term.buffer.active.viewportY,
          cellH,
          visibleContentHeight,
          desiredScrollTop,
        );
      } else {
        positionHostAt(term.buffer.active.viewportY, cellH, visibleContentHeight, desiredScrollTop);
      }
      container.scrollTop = desiredScrollTop;
      lastSeenScrollTop = container.scrollTop;
    }

    if (markerDisposed || options.includeDomDelta) {
      // A compositor/user delta changes which logical row the marker must identify. Re-register
      // immediately at the corrected DOM coordinate so a second reconciliation in the same
      // event cannot apply that delta twice against the old marker.
      clearLiveReviewAnchor();
      captureLiveReviewAnchor();
      return;
    }
    anchor.lastLine = resolvedLine;
    anchor.rowIdentityOffset = currentRowIdentityOffset;
    anchor.scrollTopAtCapture = desiredScrollTop;
  };

  function normalizeNearInteger(value: number): number {
    const rounded = Math.round(value);
    const ulpTolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
    return Math.abs(value - rounded) <= ulpTolerance ? rounded : value;
  }

  function getHistoryProjectionKey(projection: PtyHistoryProjection): string {
    return [
      projection.kind,
      bufferRevision,
      projection.startLine,
      projection.endLine,
      projection.rowHeight,
      projection.topOffset,
    ].join(":");
  }

  function renderHistoryProjection(
    projection: PtyHistoryProjection | null,
    options: { force?: boolean } = {},
  ): boolean {
    if (!projection) {
      if (activeHistoryProjection) onHistoryProjectionChange?.(null);
      activeHistoryProjection = null;
      return true;
    }

    const key = getHistoryProjectionKey(projection);
    if (!options.force && activeHistoryProjection?.key === key) return true;
    const rendered = onHistoryProjectionChange?.(projection) === true;
    if (rendered) {
      activeHistoryProjection = { kind: projection.kind, key };
      return true;
    }

    // A failed replacement must not leave the previous mode's projection on screen.
    if (activeHistoryProjection) onHistoryProjectionChange?.(null);
    activeHistoryProjection = null;
    return false;
  }

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
      if (nextReviewing) captureLiveReviewAnchor();
      else clearLiveReviewAnchor();
    }
    if (result.notifyTouchReviewStart) {
      cancelPendingPageResumeRestore("touch-review");
      onTouchReviewStart?.();
    }
    return result;
  };

  const syncLiveBackfill = (
    ydisp: number,
    cellH: number,
    visibleContentHeight: number,
    scrollTop: number,
  ): void => {
    const geometryOrigin = computeHostTop({
      ydisp: 0,
      rows: term.rows,
      cellH,
      visibleContentHeight,
    });
    const plan = computePtyLiveBackfill({
      ydisp,
      rows: term.rows,
      cellH,
      visibleContentHeight,
      visibleTopLine: Math.max(0, (scrollTop - geometryOrigin) / cellH),
    });
    if (!plan) {
      renderHistoryProjection(null);
      return;
    }
    renderHistoryProjection({
      kind: "live-backfill",
      startLine: plan.startLine,
      endLine: plan.endLine,
      rowHeight: plan.rowHeight,
      topOffset: plan.topOffset,
    });
  };

  const syncTransientViewportBridge = (
    paintedYdisp: number,
    cellH: number,
    visibleContentHeight: number,
    scrollTop: number,
  ): void => {
    const geometryOrigin = computeHostTop({
      ydisp: 0,
      rows: term.rows,
      cellH,
      visibleContentHeight,
    });
    const plan = computePtyLiveViewportBridge({
      ydisp: paintedYdisp,
      rows: term.rows,
      cellH,
      bufferLength: term.buffer.active.length,
      visibleContentHeight,
      visibleTopLine: Math.max(0, (scrollTop - geometryOrigin) / cellH),
    });
    if (!plan) {
      renderHistoryProjection(null);
      return;
    }
    // The xterm rows still represent `paintedYdisp`, but a keyboard/font/layout change may already
    // have changed the row height or the short-host geometry origin while that paint is pending.
    // Anchor the live bridge in the *current* buffer coordinate plane relative to the host's actual
    // (still old) DOM position. When geometry is unchanged this reduces exactly to
    // `(startLine - paintedYdisp) * cellH`; during relayout it prevents the bridge from inheriting
    // the old host origin and jumping by the keyboard/viewport delta for one frame.
    const currentHostTop = Number.parseFloat(host.style.top);
    const paintedHostTop = Number.isFinite(currentHostTop)
      ? currentHostTop
      : computeHostTop({
          ydisp: paintedYdisp,
          rows: term.rows,
          cellH,
          visibleContentHeight,
        });
    const topOffset = geometryOrigin + plan.startLine * cellH - paintedHostTop;
    renderHistoryProjection({
      kind: "live-backfill",
      startLine: plan.startLine,
      endLine: plan.endLine,
      rowHeight: plan.rowHeight,
      topOffset,
    });
  };

  const positionHostAt = (
    ydisp: number,
    cellH: number,
    visibleContentHeight?: number,
    scrollTop: number = container.scrollTop,
  ): void => {
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
    positionedHostYdisp = ydisp;
    deferredViewportPaintPending = false;
    syncLiveBackfill(ydisp, cellH, resolvedVisibleContentHeight, scrollTop);
    // host.top 没变那一帧 (focus 切换 / theme 重绘 / 同 buffer 重 paint) 不 trace, 减少稳态噪音。
    if (prevTopPx === nextTopPx) return;
    trace("host-position", {
      ydisp,
      details: `${prevTopPx || "0px"}->${nextTopPx}`,
    });
  };

  function commitVerticalFrameCoordinates(plan: PtyVerticalFramePlan): number {
    // Host first: xterm's synchronous onScroll observers must never see the new viewport row
    // paired with the previous host position. `syncing.internal` only owns xterm's synchronous
    // callback; keeping it set across the native container write changes review/touch event
    // ownership and can collapse a real history gesture back onto xterm's live viewport.
    if (plan.cellH > 0) {
      positionHostAt(plan.viewportY, plan.cellH, plan.visibleContentHeight, plan.scrollTop);
    }
    syncing.internal = true;
    try {
      if (term.buffer.active.viewportY !== plan.viewportY) {
        term.scrollToLine(plan.viewportY);
      }
    } finally {
      syncing.internal = false;
    }
    container.scrollTop = plan.scrollTop;
    return container.scrollTop;
  }

  const commitLiveFrame = (plan: PtyLiveFramePlan, scrollOwner: PtyLiveFrameScrollOwner): void => {
    // A live frame has one programmatic scroll owner. Publish the target before the DOM write so
    // even a synchronous scroll event can identify the write; never leave a stale owner from an
    // earlier cursor-follow or bottom-follow transaction competing with this one.
    if (scrollOwner === "programmatic-bottom") {
      pendingFollowCursorScrollTop = null;
      pendingProgrammaticScrollTop = plan.scrollTop;
    } else {
      pendingProgrammaticScrollTop = null;
      pendingFollowCursorScrollTop = plan.scrollTop;
    }

    let landedScrollTop: number;
    try {
      landedScrollTop = commitVerticalFrameCoordinates(plan);
    } catch (error) {
      if (scrollOwner === "programmatic-bottom") pendingProgrammaticScrollTop = null;
      else pendingFollowCursorScrollTop = null;
      throw error;
    }

    // The browser may clamp while a new spacer is committing. If the pending marker was not
    // synchronously consumed, align it with the value that actually landed; the next layout can
    // retry the immutable semantic target from a fresh snapshot.
    if (scrollOwner === "programmatic-bottom") {
      if (pendingProgrammaticScrollTop !== null) {
        pendingProgrammaticScrollTop = landedScrollTop;
      }
    } else if (pendingFollowCursorScrollTop !== null) {
      pendingFollowCursorScrollTop = landedScrollTop;
    }
    lastSeenScrollTop = landedScrollTop;
    prevCursorBufferRow = plan.cursorBufferRow;
  };

  const scrollToBottom = (reason: string = "internal", opts: { force?: boolean } = {}): void => {
    // 默认 respect intent: intent=true (用户在回看) 时整段 no-op, 不清 intent / 不 trace /
    // 不写 scrollTop / 不写 host。被动 caller (pendingFrame / relayout / termScroll)
    // 应当被回看意图压过, 否则用户每次想看历史都会被远端 / xterm onData
    // 自动响应 / 焦点切换之类的事件无形拉走。
    // force=true 是用户明示动作 (BackToBottom / init / 修 stale state programmaticDrift)
    // 的 opt-out, 这条路径仍清 intent + 拉底, 表示"用户想从回看模式退出回到 follow"。
    // no-op 早返: 已在 semantic bottom + intent=false + viewportY 命中目标 → 不工作不 trace。
    // pendingContainerSyncRetry=false 语义保留 (scrollToBottom 永远清干净 stale state)。
    if (opts.force) {
      // An explicit request to resume live output supersedes every older restore transaction.
      // Otherwise a reconnect that has not replayed enough history yet can re-enter reviewing on
      // the next render after raw input already returned the user to the live tail.
      cancelPendingPageResumeRestore(`scroll-to-bottom:${reason}`);
    }
    const frame = readLiveFrameSnapshot();
    const anchor = frame.anchor;
    const expectedYdisp = anchor.bottomViewportY;
    const action = decideScrollToBottomAction({
      force: opts.force ?? false,
      reviewing: userHasVerticalScrollIntent() || verticalIntent.touchActive,
      viewportY: frame.viewportY,
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
    commitLiveFrame(
      {
        viewportY: expectedYdisp,
        scrollTop: anchor.bottomScrollTop,
        cellH: frame.cellH,
        visibleContentHeight: frame.visibleContentHeight,
        cursorBufferRow: frame.cursorBufferRow,
      },
      "programmatic-bottom",
    );
    notifyScroll();
    // 清零必须放在最末尾: container.scrollTop 写入会同步触发 onContainerScroll →
    // syncContainerScroll, 此时若 cellH=0 会重新置位 retry flag。开头清零的话这里又会被覆盖,
    // 让 scrollToBottom 的"重置 stale state"语义不真。在所有同步副作用后再清,确保边界干净。
    pendingContainerSyncRetry = false;
    trace("scroll-to-bottom:end", { ydisp: expectedYdisp });
  };

  const reconcileActiveBufferSwitch = (
    site: string,
    options: { forceBoundary?: boolean; crossedTypeBoundary?: boolean } = {},
  ): boolean => {
    const nextType = term.buffer.active.type;
    if (nextType === activeBufferType && !options.forceBoundary) return false;
    const previousType = activeBufferType;
    const crossedTypeBoundary = options.crossedTypeBoundary === true || nextType !== previousType;
    const isSameTypeBoundary = !crossedTypeBoundary && nextType === previousType;
    const preserveReviewIntent =
      isSameTypeBoundary && nextType === "normal" && userHasVerticalScrollIntent();
    activeBufferType = nextType;

    // Every buffer-change event is a row-space identity boundary. In particular, xterm reuses the
    // public normal BufferApiView across RIS/Terminal.reset, so neither its old marker nor its old
    // numeric row can be trusted after this point.
    clearLiveReviewAnchor();
    renderHistoryProjection(null);
    deferredViewportPaintPending = false;
    positionedHostYdisp = null;
    pendingContainerSyncRetry = false;
    trace("buffer-switch", {
      details: `${previousType}->${nextType} site=${site} forced=${options.forceBoundary ? 1 : 0} crossed=${crossedTypeBoundary ? 1 : 0}`,
    });
    updateSpacer();

    if (preserveReviewIntent) {
      // A new authoritative normal row space has no old->new row identity mapping. Do not invent
      // one, but also never reinterpret "the user is reviewing" as permission to jump to the live
      // tail. Anchor the replacement buffer at its earliest surviving row and let subsequent live
      // output grow below it. This is deterministic, keeps the follow lock intact, and prevents a
      // reconnect/reset from turning into an implicit Back-to-bottom action.
      prevCursorBufferRow = null;
      pendingProgrammaticScrollTop = null;
      pendingFollowCursorScrollTop = null;
      sameTypeReviewBoundaryAwaitingWrite = true;
      const { cellH, visibleContentHeight } = readLiveFrameSnapshot();
      if (cellH > 0) {
        lastSeenScrollTop = commitVerticalFrameCoordinates({
          viewportY: 0,
          scrollTop: 0,
          cellH,
          visibleContentHeight,
        });
        captureLiveReviewAnchor();
      } else {
        container.scrollTop = 0;
        lastSeenScrollTop = container.scrollTop;
        pendingContainerSyncRetry = true;
      }
      notifyScroll();
      return true;
    }

    // Normal and alternate buffers have independent screen ownership. A real type switch exits
    // review and shows the new active screen's live tail; horizontal coordinates are independent
    // as well, so stale sideways review must not leak across the switch.
    sameTypeReviewBoundaryAwaitingWrite = false;
    if (crossedTypeBoundary) resetHorizontalScroll(`bufferSwitch:${previousType}->${nextType}`);
    scrollToBottom(`bufferSwitch:${previousType}->${nextType}`, { force: true });
    return true;
  };

  const preparePageResumeRestore = (): void => {
    pageResumeRestorePending = true;
    trace("page-resume:prepare");
  };

  const restorePageResume = (): void => {
    preparePageResumeRestore();
    updateSpacer();
    scrollToBottom("pageResume", { force: true });
    resetHorizontalScroll("pageResume");
    pageResumeRestorePending = false;
  };

  const scrollToRatio = (ratio: number): void => {
    cancelPendingPageResumeRestore("vertical-ratio");
    trace("scroll-to-ratio:start");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(1, ratio));
    if (clamped === 1) {
      // The native PTY scrollbar is hidden, so the custom ratio control is an explicit owner.
      // Its bottom endpoint means "resume live following" and commits the semantic target.
      scrollToBottom("scrollToRatio", { force: true });
      return;
    }
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
    cancelPendingPageResumeRestore("vertical-wheel");
    trace("wheel");
    const anchor = getCurrentAnchor();
    const previous = container.scrollTop;
    const reachedSemanticBottom = shouldWheelCommitPtySemanticBottom({
      reviewing: userHasVerticalScrollIntent(),
      deltaY,
      currentScrollTop: previous,
      bottomScrollTop: anchor.bottomScrollTop,
      atBottomThreshold,
    });
    if (reachedSemanticBottom) {
      trace("wheel:semantic-bottom");
      // The semantic bottom is a coupled viewportY / host.top / scrollTop target. Reuse the
      // canonical commit so viewport, host and browser scroll land in the same frame.
      scrollToBottom("wheel", { force: true });
      return;
    }

    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const maxScrollTop = resolvePtyNativeScrollMax({
      reviewing: userHasVerticalScrollIntent(),
      referenceScrollTop: previous,
      bottomScrollTop: anchor.bottomScrollTop,
      domMaxScrollTop,
      atBottomThreshold,
    });
    if (maxScrollTop <= 0) {
      trace("wheel:max-zero");
      return;
    }
    const next = Math.max(0, Math.min(maxScrollTop, previous + deltaY));
    if (next === previous) {
      // 已经 clamp 到边界 (顶 / 底), 真实 scrollTop 不动 — 不该把 intent 再 set 一遍,
      // 否则用户在底反复 wheel down 会把 output 重新 pause。
      trace("wheel:clamped");
      notifyScroll();
      return;
    }
    // Wheel is an explicit user-owned path. Establish review ownership before the DOM write so
    // the synchronous scroll event cannot be mistaken for an ownerless browser/layout replay and
    // canonicalized back to the live tail. Downward wheel keeps its existing post-write commit so
    // it can release review only after the cursor-aware bottom frame has actually landed.
    if (deltaY < 0) {
      dispatchVerticalIntent({
        type: "wheel",
        deltaY,
        previousScrollTop: previous,
        nextScrollTop: next,
        reachedCursorAwareBottom: false,
      });
    }
    container.scrollTop = next;
    lastSeenScrollTop = next;
    syncContainerScroll();
    // 向下滚到底 (next > previous 且抵达 atBottom) 释放 intent。向上滚不清, 即便
    // longHost 模式下 cursor 仍可见 (atBottom 仍 true)。
    if (deltaY > 0) {
      dispatchVerticalIntent({
        type: "wheel",
        deltaY,
        previousScrollTop: previous,
        nextScrollTop: next,
        reachedCursorAwareBottom:
          next >= anchor.bottomScrollTop - atBottomThreshold && getCurrentAnchor().isAtBottom,
      });
    }
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

  const resetHorizontalScroll = (
    reason: string = "external",
    opts: { holdUntilCursorVisible?: boolean } = {},
  ): void => {
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
    if (opts.holdUntilCursorVisible) {
      markHorizontalUserInput(`site=resetHorizontalScroll-hold reason=${reason}`);
    }
    trace(`horizontal-scroll-reset[${reason}]`, {
      details: `scrollLeft=${previous}->${container.scrollLeft}`,
    });
    notifyScroll();
  };

  const markHorizontalScrollIntent = (reason: string = "external"): void => {
    markHorizontalUserInput(`site=${reason}`);
  };

  const markSelectionAutoscrollIntent = (reason: string = "selection-autoscroll"): void => {
    cancelPendingPageResumeRestore(`vertical:${reason}`);
    dispatchVerticalIntent({
      type: "mark-review",
      source: "selection-autoscroll",
      scrollTop: container.scrollTop,
      reason,
    });
  };

  // liveLastY 扫描会跑到 term.rows 行，每帧 onRender 都跑一次浪费。
  // 用 buffer revision 当 cache key：xterm.onWriteParsed 写完就 ++，加上 baseY/rows。
  // semantic bottom 会把 viewportY 移入历史，viewportY 不能参与 live screen 缓存语义。
  let bufferRevision = 0;
  let cachedLiveLastYKey: string | null = null;
  let cachedLiveLastY = -1;
  const getCachedLiveLastY = (): number => {
    const buffer = term.buffer.active;
    const key = `${buffer.type}:${bufferRevision}:${buffer.baseY}:${buffer.length}:${term.rows}`;
    if (key === cachedLiveLastYKey) return cachedLiveLastY;
    cachedLiveLastY = findLiveScreenLastNonEmptyRow(buffer, term.rows);
    cachedLiveLastYKey = key;
    return cachedLiveLastY;
  };

  const updateSpacer = (options: { commitDeferredPaint?: boolean } = {}): void => {
    const { cellH, cellW } = getDims();
    if (cellH === 0 || cellW === 0) return;
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    const liveLastY = getCachedLiveLastY();
    const layout = computePtyHostLayout(
      {
        bufferLength: buffer.length,
        baseY: buffer.baseY,
        rows: term.rows,
        cols: term.cols,
        viewportY: buffer.viewportY,
        cursorY: buffer.cursorY,
        cellH,
        cellW,
        visibleContentHeight,
      },
      liveLastY,
    );
    if (!layout) return;
    // Keep an in-flight compositor position reachable while a touch is active. Outside that
    // transient window the spacer always reflects the current, growing xterm buffer.
    const requiredTouchRange = verticalIntent.touchActive
      ? container.scrollTop + visibleContentHeight
      : 0;
    const spacerHeight = Math.max(layout.spacerHeight, requiredTouchRange);
    setStyle(spacer, "overflow", "hidden");
    setStyle(spacer, "height", `${spacerHeight}px`);
    setStyle(spacer, "width", `${layout.spacerWidth}px`);
    setStyle(host, "width", `${layout.hostWidth}px`);
    setStyle(host, "height", `${layout.hostHeight}px`);
    setStyle(host, "paddingTop", `${layout.hostPaddingTop}px`);
    lastSpacerUpdateAt = performance.now();
    if (deferredViewportPaintPending && !options.commitDeferredPaint) {
      syncTransientViewportBridge(
        positionedHostYdisp ?? buffer.viewportY,
        cellH,
        visibleContentHeight,
        container.scrollTop,
      );
      return;
    }
    positionHostAt(buffer.viewportY, cellH, visibleContentHeight);
  };

  const syncViewportAndHostAt = (
    ydisp: number,
    cellH: number,
    opts: { deferHostUntilRender?: boolean } = {},
  ): void => {
    // Once a viewport paint is pending, no later caller may opt back into synchronous host moves.
    // xterm synchronized-output can legitimately delay onRender beyond the native inertia window;
    // moving the host in that interval would expose old glyph rows at the requested coordinates.
    const deferHostUntilRender =
      opts.deferHostUntilRender === true ||
      deferredViewportPaintPending ||
      verticalIntent.touchActive;
    if (deferHostUntilRender) {
      const { visibleContentHeight } = readReviewGeometry(cellH);
      const paintedYdisp = positionedHostYdisp ?? term.buffer.active.viewportY;
      const viewportAlreadyPainted =
        !deferredViewportPaintPending && paintedYdisp === term.buffer.active.viewportY;
      if (ydisp === term.buffer.active.viewportY && viewportAlreadyPainted) {
        positionHostAt(ydisp, cellH, visibleContentHeight);
        return;
      }

      // The outer native scroller has already moved. Keep the old xterm rows at their old absolute
      // coordinates and cover the current browser viewport from the live buffer until xterm tells
      // us that the requested viewport has painted.
      syncTransientViewportBridge(paintedYdisp, cellH, visibleContentHeight, container.scrollTop);
      deferredViewportPaintPending = true;
      if (ydisp === term.buffer.active.viewportY) return;
      syncing.internal = true;
      try {
        term.scrollToLine(ydisp);
      } finally {
        syncing.internal = false;
      }
      return;
    }

    if (ydisp === term.buffer.active.viewportY) {
      positionHostAt(ydisp, cellH);
      return;
    }

    syncing.internal = true;
    try {
      positionHostAt(ydisp, cellH);
      term.scrollToLine(ydisp);
    } finally {
      syncing.internal = false;
    }
  };

  const handlePendingNewFrame = (): PendingFrameResult => {
    if (!hasNewFrame()) return "none";
    // The native scroller owns the viewport for the whole touch lifetime, including the
    // sub-threshold phase before the browser has classified the gesture. Consuming the frame
    // here would let pendingFrame/relayout pull a slow drag back to bottom one row at a time.
    if (verticalIntent.touchActive && !userHasVerticalScrollIntent()) {
      return "deferred";
    }
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

  function getAbsoluteYdispForScrollTop(scrollTop: number, cellH: number): number {
    const buffer = term.buffer.active;
    if (userHasVerticalScrollIntent()) {
      const { geometryOrigin, visibleContentHeight } = readReviewGeometry(cellH);
      const logicalTop = Math.max(0, (scrollTop - geometryOrigin) / cellH);
      const logicalVisibleEnd = normalizeNearInteger(logicalTop + visibleContentHeight / cellH);
      // Render the smallest xterm viewport that still covers the outer browser viewport's lower
      // edge. This enters xterm's native user-scrolling mode as soon as a whole row is available,
      // while the marker above preserves sub-row/shallow review across full-scrollback trims.
      return Math.max(0, Math.min(buffer.baseY, Math.ceil(logicalVisibleEnd) - term.rows));
    }
    return computeScrollTarget(scrollTop, {
      bufferLength: buffer.length,
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
      cellH,
      cellW: 1,
    }).ydisp;
  }

  function getYdispForScrollTop(scrollTop: number, cellH: number): number {
    // A semantic bottom is not necessarily an exact DOM pixel boundary. Chrome
    // quantizes scrollHeight/scrollTop, so the landed value can be a fraction below
    // `bottomScrollTop`; flooring that pixel value would move xterm back one row.
    // The semantic anchor is authoritative inside the same threshold used by
    // at-bottom detection. Review positions farther away keep their own row mapping.
    if (canPassiveFollow(verticalIntent)) {
      const anchor = getCurrentAnchor();
      if (Math.abs(scrollTop - anchor.bottomScrollTop) <= atBottomThreshold) {
        return anchor.bottomViewportY;
      }
    }
    return getAbsoluteYdispForScrollTop(scrollTop, cellH);
  }

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
    if (userHasVerticalScrollIntent()) {
      reconcileLiveReviewAnchor(cellH, { includeDomDelta: true });
    }
    const ydisp = getYdispForScrollTop(container.scrollTop, cellH);
    syncViewportAndHostAt(ydisp, cellH, {
      deferHostUntilRender: opts.deferHostUntilRender,
    });
    if (userHasVerticalScrollIntent()) captureLiveReviewAnchor();
    notifyScroll();
    trace("container-sync:end", { ydisp });
  };

  const isRecentTouchNativeScroll = (): boolean =>
    verticalIntent.touchActive || touchHandler.isRecentNativeScroll();

  const skipSameRowTouchScrollSync = (): boolean => {
    if (!isRecentTouchNativeScroll()) return false;
    const { cellH } = getDims();
    if (cellH === 0) return false;
    if (userHasVerticalScrollIntent()) {
      reconcileLiveReviewAnchor(cellH, { includeDomDelta: true });
    }
    const currentScrollTop = container.scrollTop;
    const ydisp = getYdispForScrollTop(currentScrollTop, cellH);
    if (ydisp !== term.buffer.active.viewportY) return false;
    // A fractional outer scroll can expose the preceding buffer row before the integer xterm
    // viewport changes (especially when the phone viewport is taller than the remote PTY). Refresh
    // the live derived rows even on this same-ydisp path; otherwise the newly exposed sliver is a
    // real black seam until the next whole-row transition.
    syncViewportAndHostAt(ydisp, cellH, {
      deferHostUntilRender: isRecentTouchNativeScroll(),
    });
    scheduleTouchScrollNotify();
    trace("container-sync:skip[same-row-touch]", {
      ydisp,
      details: `scrollTop=${Math.round(currentScrollTop)} viewportY=${term.buffer.active.viewportY}`,
    });
    return true;
  };

  const clampCursorAwareBottomOverscroll = (
    rawScrollTop: number,
    referenceScrollTop: number,
  ): number => {
    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const anchor = getCurrentAnchor();
    const decision = decideCursorAwareClamp({
      rawScrollTop,
      referenceScrollTop,
      bottomScrollTop: anchor.bottomScrollTop,
      domMaxScrollTop,
      reviewing: userHasVerticalScrollIntent(),
      atBottomThreshold,
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
    getPageResumePending: () => pageResumeRestorePending,
    getVerticalIntent: () => verticalIntent,
    dispatchVerticalIntent,
    getCurrentAnchor,
    getLastSeenScrollTop: () => lastSeenScrollTop,
    hasHorizontalOverflow,
    clearHorizontalIntentIfUnscrollable,
    markHorizontalUserInput,
    notifyAtBottom,
    flushPendingTouchScrollNotify,
  });

  const shouldHoldHorizontalIntentForTouch = (): boolean => {
    if (!horizontalState.intent) return false;
    return (
      touchHandler.getState().gestureMode === "horizontal" ||
      touchHandler.isRecentHorizontalGesture()
    );
  };

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
    const hostTopRestoreEligible = touchHandler.getState().startedAtCursorAwareBottom;
    const jumpedToHostTop =
      hostTopRestoreEligible &&
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

  const onContainerScroll = (): void => {
    trace("container-scroll");
    if (reconcileActiveBufferSwitch("containerScroll")) return;
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
    // Keep a physical delta for touch diagnostics and bare-layout traces. Vertical intent itself
    // is owned by wheel/touch/ratio/selection paths before this DOM event arrives.
    const rawScrollTop = container.scrollTop;
    const previousSeenScrollTop = lastSeenScrollTop;
    const verticalDelta = rawScrollTop - lastSeenScrollTop;
    const effectiveScrollTop = clampCursorAwareBottomOverscroll(
      rawScrollTop,
      previousSeenScrollTop,
    );
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
      });
      notifyScroll();
      return;
    }
    if (sourceDecision.action === "programmatic-bottom") {
      dispatchVerticalIntent({
        type: "container-scroll",
        source: "programmatic-bottom",
        scrollTop: effectiveScrollTop,
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
      });
      scrollToBottom("programmaticDrift");
      return;
    }
    if (restoreImpossibleTouchScrollJump(effectiveScrollTop)) {
      return;
    }
    if (pageResumeRestorePending) {
      trace("container-scroll:page-resume-pending", {
        details: `scrollTop=${effectiveScrollTop} bottom=${getCurrentAnchor().bottomScrollTop}`,
      });
      // Lifecycle DOM replay has no user-input ownership. Do not project it into the logical
      // review state and do not write an older saved coordinate back; activation performs one
      // canonical live-tail commit.
      notifyScroll();
      return;
    }
    if (
      userHasVerticalScrollIntent() &&
      isRecentTouchNativeScroll() &&
      verticalDelta > 0 &&
      effectiveScrollTop >= getCurrentAnchor().bottomScrollTop - atBottomThreshold
    ) {
      // Native inertia may reach the real, growing live tail after touchend. Release the follow
      // lock only at that current semantic boundary; there is no captured/old review boundary.
      scrollToBottom("touchSemanticBottom", { force: true });
      return;
    }
    // The browser-native scrollbar is hidden. Every real user-owned vertical path establishes
    // ownership before its DOM scroll lands: wheel is captured, touch uses its FSM, and the
    // custom scrollbar calls scrollToRatio. A bare container scroll while the preceding frame is
    // following is therefore browser/layout synchronization, never new review intent.
    //
    // Android keyboard close exposes the ordering this invariant protects: Chrome can clamp the
    // old native range and emit scroll before ResizeObserver relayouts the now-short host. Commit
    // viewportY / host.top / scrollTop as one semantic frame instead of snapshotting that clamp.
    if (canPassiveFollow(verticalIntent)) {
      if (!atBottom) {
        trace("container-scroll:canonical-follow", {
          details: `scrollTop=${effectiveScrollTop} bottom=${getCurrentAnchor().bottomScrollTop} delta=${verticalDelta}`,
        });
      }
      updateSpacer();
      // `atBottom` is a geometry predicate, not proof that xterm viewportY and host.top already
      // form the canonical semantic frame. Let scrollToBottom decide whether the full coupled
      // target is already aligned; otherwise repair all three coordinates atomically.
      scrollToBottom("containerBrowserSync");
      return;
    }
    if (skipSameRowTouchScrollSync()) {
      if (userHasVerticalScrollIntent() && verticalDelta !== 0) captureLiveReviewAnchor();
      return;
    }
    syncContainerScroll({ deferHostUntilRender: isRecentTouchNativeScroll() });
  };

  const reconcileTermScroll = (): void => {
    trace("term-scroll");
    if (reconcileActiveBufferSwitch("termScroll")) return;
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
        if (userHasVerticalScrollIntent()) reconcileLiveReviewAnchor(cellH);
        const ydisp = getYdispForScrollTop(container.scrollTop, cellH);
        syncViewportAndHostAt(ydisp, cellH);
      }
      notifyScroll();
    } finally {
      syncing.external = false;
    }
  };

  const cancelPendingTermScrollReconcile = (): void => {
    if (pendingTermScrollReconcileFrame === null) return;
    pendingTermScrollReconcileCancel?.(pendingTermScrollReconcileFrame);
    pendingTermScrollReconcileFrame = null;
    pendingTermScrollReconcileCancel = null;
  };

  const onTermScroll = (): void => {
    // Controller-owned viewport commits already position host/xterm/DOM atomically. Their
    // synchronous xterm callback must neither reconcile nor reserve an otherwise empty RAF.
    if (syncing.internal || disposed || pendingTermScrollReconcileFrame !== null) return;
    if (typeof window.requestAnimationFrame !== "function") {
      reconcileTermScroll();
      return;
    }
    pendingTermScrollReconcileFrame = window.requestAnimationFrame(() => {
      pendingTermScrollReconcileFrame = null;
      pendingTermScrollReconcileCancel = null;
      if (disposed) return;
      reconcileTermScroll();
    });
    pendingTermScrollReconcileCancel =
      typeof window.cancelAnimationFrame === "function"
        ? (handle) => window.cancelAnimationFrame(handle)
        : null;
  };

  const relayout = (): void => {
    // start/end 不 trace, layout 真改了 (host-position) / scrollToBottom 真触发 / pending-sync-retry-fire
    // 这些子路径自己有独立 trace, 框 trace 是稳态噪音。
    if (reconcileActiveBufferSwitch("relayout")) return;
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
    if (userHasVerticalScrollIntent()) {
      const { cellH } = getDims();
      if (cellH <= 0) {
        pendingContainerSyncRetry = true;
        notifyScroll();
        return;
      }
      // A user scroll can land while font/layout measurement temporarily reports cellH=0.
      // That DOM position is newer than the marker captured before the measurement gap. Apply it
      // first and let syncContainerScroll replace the marker; reconciling the old marker here
      // would incorrectly pull the reader back to the previous row.
      if (pendingContainerSyncRetry) {
        trace("pending-sync-retry-fire");
        syncContainerScroll();
        return;
      }
      reconcileLiveReviewAnchor(cellH);
      syncViewportAndHostAt(getYdispForScrollTop(container.scrollTop, cellH), cellH);
      notifyScroll();
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
    const frame = readLiveFrameSnapshot();
    const { cellH, visibleContentHeight, cursorBufferRow, anchor } = frame;
    const prevRow = prevCursorBufferRow;
    const decision = decideFollowCursorY({
      reviewing: userHasVerticalScrollIntent() || verticalIntent.touchActive,
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
    // anchor.bottomScrollTop 是 semantic live tail 的统一目标。
    if (decision.reason === "aligned") {
      trace("followCursorY:skip", {
        cursorDeltaRows: decision.cursorDeltaRows,
        details: `cursorRow=${prevRow ?? "null"}->${cursorBufferRow} aligned`,
      });
      return;
    }
    if (decision.action !== "follow") return;
    const prevScrollTop = container.scrollTop;
    commitLiveFrame(
      {
        viewportY: anchor.bottomViewportY,
        scrollTop: decision.targetScrollTop,
        cellH,
        visibleContentHeight,
        cursorBufferRow,
      },
      "follow-cursor",
    );
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
      if (shouldHoldHorizontalIntentForTouch()) {
        trace("followCursorX:skip", {
          details: `horizontalTouchIntent cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
        });
        return;
      }
      // 用户滚回到光标可见范围 (或光标自己进了 viewport), 重新 engage 跟踪
      const result = clearPtyHorizontalIntent(horizontalState, {
        details: `site=followCursorX cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
        scrollLeft: container.scrollLeft,
      });
      horizontalState = result.state;
      traceHorizontalIntent(result.trace);
      if (result.trace) {
        trace("followCursorX:skip", { details: "cursorInViewport" });
        return;
      }
    }
    if (horizontalState.intent) {
      trace("followCursorX:skip", {
        details: `horizontalIntent cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight}`,
      });
      return;
    }
    const rightMarginPx = Math.min(
      container.clientWidth / 2,
      PTY_SCROLL_CONFIG.horizontal.cursorFollowRightMarginColumns * cellW,
    );
    const rightFollowBoundary = viewportRight - rightMarginPx;
    const cursorNeedsFollow = cursorPxX < viewportLeft || cursorPxX >= rightFollowBoundary;
    if (!cursorNeedsFollow) {
      trace("followCursorX:skip", {
        details: `cursorSafe cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight} rightBoundary=${rightFollowBoundary}`,
      });
      return;
    }
    const target = Math.max(0, cursorPxX - container.clientWidth / 2);
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const pendingFollowLeft = Math.min(maxScrollLeft, target);
    horizontalState = setPtyHorizontalPendingFollow(horizontalState, pendingFollowLeft);
    container.scrollLeft = pendingFollowLeft;
    trace("followCursorX:hit", {
      details: `cursorPx=${cursorPxX} viewport=${viewportLeft}..${viewportRight} rightBoundary=${rightFollowBoundary} target=${pendingFollowLeft}`,
    });
  };

  const onRender = (): void => {
    trace("render");
    if (reconcileActiveBufferSwitch("render")) return;
    // xterm has now painted its current viewport. Move the host and replace the one-paint live
    // bridge in this same callback so old glyph rows are never exposed at the new coordinates.
    updateSpacer({ commitDeferredPaint: true });
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
    if (userHasVerticalScrollIntent()) {
      const { cellH } = getDims();
      if (cellH > 0) {
        reconcileLiveReviewAnchor(cellH);
        syncViewportAndHostAt(getYdispForScrollTop(container.scrollTop, cellH), cellH);
      }
    }
    notifyScroll();
  };

  updateSpacer();
  if (userHasVerticalScrollIntent()) {
    captureLiveReviewAnchor();
    lastSeenScrollTop = container.scrollTop;
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
    onTouchEnd: (event) => {
      touchHandler.onTouchEnd(event);
      relayout();
    },
    onTouchCancel: (event) => {
      touchHandler.onTouchCancel(event);
      relayout();
    },
    onContainerScroll,
    onTermScroll,
    onRender,
    onRelayout: relayout,
    onWriteParsed: () => {
      bufferRevision += 1;
      if (!sameTypeReviewBoundaryAwaitingWrite) return;
      sameTypeReviewBoundaryAwaitingWrite = false;
      if (!userHasVerticalScrollIntent() || term.buffer.active.type !== "normal") return;
      const { cellH } = getDims();
      if (cellH <= 0) {
        pendingContainerSyncRetry = true;
        return;
      }
      reconcileLiveReviewAnchor(cellH);
      syncViewportAndHostAt(getYdispForScrollTop(container.scrollTop, cellH), cellH);
    },
  });
  const bufferChangeDisposable = term.buffer.onBufferChange(() => {
    // Direct Terminal.reset does not necessarily produce a later onWriteParsed callback. Invalidate
    // every buffer-derived cache synchronously at the identity boundary itself.
    bufferRevision += 1;
    // A single parser chunk may enter and leave the alternate screen before this microtask runs.
    // Remember that a real type boundary occurred even if the final public type equals the type
    // at the start of the task; final-state comparison alone would misclassify that round trip as
    // a same-type normal reset.
    if (term.buffer.active.type !== activeBufferType) bufferBoundaryCrossedType = true;
    // xterm fires this while processing DECSET/DECRST. Finish the control sequence first, then
    // commit the new buffer before its already-scheduled render RAF. This prevents an onRender
    // callback from reporting the preserved viewport and only afterwards moving its glyphs to the
    // live tail for a frame.
    if (bufferBoundaryReconcileQueued) return;
    bufferBoundaryReconcileQueued = true;
    queueMicrotask(() => {
      bufferBoundaryReconcileQueued = false;
      if (disposed) return;
      const crossedTypeBoundary = bufferBoundaryCrossedType;
      bufferBoundaryCrossedType = false;
      // onBufferChange also fires for RIS/Terminal.reset, where a brand-new normal buffer has the
      // same public `type`. The event itself is the row-space identity boundary; never let markers
      // or review pixels survive merely because both sides are named "normal".
      reconcileActiveBufferSwitch("bufferChange", {
        forceBoundary: true,
        crossedTypeBoundary,
      });
    });
  });

  const getDebugProbe = (): PtyScrollDebugProbe => {
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    return {
      cellH,
      cellW,
      paddingTop,
      paddingBottom,
      liveLastY: cellH > 0 && cellW > 0 ? getCachedLiveLastY() : -1,
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
      disposed = true;
      cancelPendingTermScrollReconcile();
      bufferChangeDisposable.dispose();
      domAdapter.dispose();
      traceAdapter.dispose();
      cancelPendingTouchScrollNotify();
      clearLiveReviewAnchor();
      renderHistoryProjection(null);
    },
    relayout,
    scrollToBottom,
    preparePageResumeRestore,
    restorePageResume,
    scrollToRatio,
    scrollToXRatio,
    resetHorizontalScroll,
    markSelectionAutoscrollIntent,
    markHorizontalScrollIntent,
    traceRawInputFollowScheduled,
    traceRawInputFollowFire,
    getDebugProbe,
  };
}
