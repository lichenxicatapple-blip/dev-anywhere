interface PtyScrollMetrics {
  bufferLength: number;
  rows: number;
  cols: number;
  viewportY: number;
  cursorY?: number;
  cellH: number;
  cellW: number;
  visibleContentHeight?: number;
}

interface PtyHostLayout {
  spacerHeight: number;
  spacerWidth: number;
  hostWidth: number;
  hostHeight: number;
  hostPaddingTop: number;
}

interface PtyLiveBottomInput {
  bufferLength: number;
  baseY: number;
  rows: number;
  cursorY: number;
  liveLastY: number;
  cellH: number;
  visibleContentHeight: number;
  hostPaddingTop?: number;
}

interface PtyLiveBottom {
  scrollTop: number;
  viewportY: number;
  liveTailY: number;
}

interface PtyScrollTarget {
  ydisp: number;
}

interface PtyLiveBackfillPlan {
  startLine: number;
  endLine: number;
  rowCount: number;
  rowHeight: number;
  topOffset: number;
}

function normalizeNearIntegerRows(value: number): number {
  const nearest = Math.round(value);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value));
  return Math.abs(value - nearest) <= tolerance ? nearest : value;
}

export function computePtyHostLayout(
  metrics: PtyScrollMetrics & { baseY: number },
  liveLastY: number,
): PtyHostLayout | null {
  if (metrics.cellH <= 0 || metrics.cellW <= 0 || metrics.rows <= 0 || metrics.cols <= 0) {
    return null;
  }
  // hostPaddingTop 仅在冷启动 (bufferLength <= rows) 场景使用——此时整屏多数是空,
  // padding 把仅有的几行内容顶到屏幕底部, 视觉上模拟终端 "fill from bottom" 行为。
  // 长会话 (bufferLength > rows) 已进入 scrollback 区, 光标上方都是有效 buffer 行,
  // 光标下方的空行属于"光标余空"; 这时再加 paddingTop 会把 host 内容整体下推,
  // 与 positionHostAt 给出的 host.top (按 ydisp*cellH 算) 拼起来在视窗顶部留出
  // 与 padding 等高的黑带，表现为终端顶部出现空白渲染区。
  //
  // padding 底参考: 当 rows*cellH > visibleContentHeight (窄高度终端 / 移动端) 时,
  // 仅 host 顶部 visible 高度可见, padding 必须夹到 visible, 否则内容被压到截断点之下看不见。
  const hostHeight = metrics.rows * metrics.cellH;
  const isColdStart = metrics.bufferLength <= metrics.rows;
  const visibleContentHeight = Math.max(0, metrics.visibleContentHeight ?? 0);
  const paddingBottomReference =
    visibleContentHeight > 0 ? Math.min(hostHeight, visibleContentHeight) : hostHeight;
  const clampedCursorY =
    metrics.cursorY === undefined ? -1 : Math.max(0, Math.min(metrics.rows - 1, metrics.cursorY));
  const clampedLiveLastY = Math.max(-1, Math.min(metrics.rows - 1, liveLastY));
  const rowsOfContent = Math.max(1, Math.max(clampedCursorY, clampedLiveLastY) + 1);
  const hostPaddingTop = isColdStart
    ? Math.max(0, paddingBottomReference - rowsOfContent * metrics.cellH)
    : 0;
  const maxYdisp = Math.max(0, metrics.bufferLength - metrics.rows);
  const minSpacerHeightForLastViewport = maxYdisp * metrics.cellH + visibleContentHeight;
  if (visibleContentHeight > 0 && metrics.cursorY !== undefined) {
    const liveBottom = computePtyLiveBottom({
      bufferLength: metrics.bufferLength,
      baseY: metrics.baseY,
      rows: metrics.rows,
      cursorY: metrics.cursorY,
      liveLastY,
      cellH: metrics.cellH,
      visibleContentHeight,
      hostPaddingTop,
    });
    return {
      // The DOM scroll range ends at the semantic live tail, not at the final
      // server-owned row. Trailing empty PTY rows therefore cannot occupy the
      // area released when a mobile keyboard closes.
      spacerHeight: liveBottom.scrollTop + visibleContentHeight,
      spacerWidth: metrics.cols * metrics.cellW,
      hostWidth: metrics.cols * metrics.cellW,
      hostHeight,
      hostPaddingTop,
    };
  }
  return {
    spacerHeight: Math.max(metrics.bufferLength * metrics.cellH, minSpacerHeightForLastViewport),
    spacerWidth: metrics.cols * metrics.cellW,
    hostWidth: metrics.cols * metrics.cellW,
    hostHeight,
    hostPaddingTop,
  };
}

/**
 * Resolve the semantic live bottom without resizing the remote PTY.
 *
 * The browser may display fewer rows than the session owns, and the live cursor
 * may sit above many empty server-owned rows. Fill the viewport with preceding
 * scrollback, keep the cursor visible, and retain meaningful TUI rows below the
 * cursor whenever they fit.
 */
export function computePtyLiveBottom({
  bufferLength,
  baseY,
  rows,
  cursorY,
  liveLastY,
  cellH,
  visibleContentHeight,
  hostPaddingTop = 0,
}: PtyLiveBottomInput): PtyLiveBottom {
  const liveBaseY = Math.max(0, Math.min(bufferLength, baseY));
  if (rows <= 0 || cellH <= 0) {
    return { scrollTop: 0, viewportY: liveBaseY, liveTailY: 0 };
  }

  const clampedCursorY = Math.max(0, Math.min(rows - 1, cursorY));
  const clampedLiveLastY =
    liveLastY < 0 ? clampedCursorY : Math.max(0, Math.min(rows - 1, liveLastY));
  const liveTailY = Math.max(clampedCursorY, clampedLiveLastY);
  const hostHeight = rows * cellH;
  // Keep the semantic anchor in row coordinates until the final pixel write.
  // Deriving viewportY back from scrollTop / cellH is lossy for repeating
  // fractional cell heights: an exact row boundary such as 230 can become
  // 229.99999999999997 and floor to the preceding row.
  const capacityRows =
    visibleContentHeight > 0 && visibleContentHeight < hostHeight
      ? normalizeNearIntegerRows(visibleContentHeight / cellH)
      : rows;
  const hostPaddingRows = hostPaddingTop / cellH;
  const cursorTopRows = hostPaddingRows + liveBaseY + clampedCursorY;
  const tailBottomRows = hostPaddingRows + liveBaseY + liveTailY + 1;

  // If cursor and tail fit together, align the tail to the visible bottom. If
  // they do not, cursor visibility is the hard constraint and the lower TUI
  // rows are necessarily clipped.
  const scrollTopRows = Math.max(0, Math.min(tailBottomRows - capacityRows, cursorTopRows));
  const scrollTop = scrollTopRows * cellH;
  const viewportY = Math.max(0, Math.min(liveBaseY, Math.floor(scrollTopRows)));
  return { scrollTop, viewportY, liveTailY };
}

interface ScrollAnchorInput {
  rows: number;
  cellH: number;
  bufferLength: number;
  baseY: number;
  viewportY: number;
  // 光标在 live buffer 中的绝对行 (term.buffer.active.baseY + .cursorY)。
  // viewportY 会随用户回看历史变化，不能用来定位 live cursor；否则回看时会把
  // 光标错误投影到历史视窗里，让 cursor-aware atBottom 误判为 true。
  cursorBufferRow: number;
  // 从 baseY 开始扫描 live screen 得到的最后一条有效内容行（相对行号）。
  liveLastY: number;
  // container.clientHeight 扣掉上下 padding
  visibleContentHeight: number;
  // container 自身的 padding-top, 用于把 buffer 行像素和 scrollTop 坐标对齐
  paddingTop: number;
  paddingBottom: number;
  hostPaddingTop: number;
  containerScrollTop: number;
  containerScrollHeight: number;
  containerClientHeight: number;
  atBottomThreshold: number;
}

interface ScrollAnchorOutput {
  isAtBottom: boolean;
  // 用户点 "back to bottom" 或程序触发 scrollToBottom 时容器应该被设到的 scrollTop
  bottomScrollTop: number;
  bottomViewportY: number;
  cursorInViewport: boolean;
}

/**
 * 一次算出"几何贴底"和"光标可见"两件事。controller 之前两个方法各自做局部条件判断,
 * 这里集中: host 高度跟可视区比较的分支只在这一处出现, 之后任何 anchor 类决策只走这条路。
 *
 * semantic bottom 同时给出目标 scrollTop 与 xterm viewportY，调用方不再把
 * “cursor 还看得见”误当成已经贴底，也不再把 viewportY 硬编码为 maxYdisp。
 */
export function computeScrollAnchor(input: ScrollAnchorInput): ScrollAnchorOutput {
  const hostHeight = input.rows * input.cellH;
  const hostVerticalOffset =
    input.cellH > 0 && hostHeight < input.visibleContentHeight
      ? input.visibleContentHeight - hostHeight
      : 0;
  const cursorPx =
    input.paddingTop +
    hostVerticalOffset +
    input.hostPaddingTop +
    input.cursorBufferRow * input.cellH;
  const viewportTop = input.containerScrollTop + input.paddingTop;
  const viewportBottom =
    input.containerScrollTop + input.containerClientHeight - input.paddingBottom;
  const cursorViewportTolerance = Math.max(1, input.atBottomThreshold);
  const cursorRendered =
    input.cursorBufferRow >= input.viewportY &&
    input.cursorBufferRow < input.viewportY + input.rows;
  const cursorInViewport =
    input.cellH > 0 &&
    cursorRendered &&
    cursorPx >= viewportTop - cursorViewportTolerance &&
    cursorPx + input.cellH <= viewportBottom + cursorViewportTolerance;

  const maxYdisp = Math.max(0, input.bufferLength - input.rows);
  const domMaxScrollTop = Math.max(0, input.containerScrollHeight - input.containerClientHeight);
  const liveBottom = computePtyLiveBottom({
    bufferLength: input.bufferLength,
    baseY: input.baseY,
    rows: input.rows,
    cursorY: input.cursorBufferRow - input.baseY,
    liveLastY: input.liveLastY,
    cellH: input.cellH,
    visibleContentHeight: input.visibleContentHeight,
    hostPaddingTop: input.hostPaddingTop,
  });
  // Keep the semantic target even if the DOM scroll range is momentarily stale.
  // Callers can retry on the next layout/render instead of treating a clamped,
  // currently reachable value as the true bottom forever.
  const bottomScrollTop = input.cellH > 0 ? liveBottom.scrollTop : domMaxScrollTop;
  const bottomViewportY = input.cellH > 0 ? liveBottom.viewportY : maxYdisp;
  const isAtBottom =
    Math.abs(input.containerScrollTop - bottomScrollTop) <= input.atBottomThreshold &&
    (input.cellH <= 0 || cursorInViewport);
  return {
    isAtBottom,
    bottomScrollTop,
    bottomViewportY,
    cursorInViewport,
  };
}

interface HostTopInput {
  ydisp: number;
  rows: number;
  cellH: number;
  visibleContentHeight?: number;
}

/**
 * 计算 host 在 spacer 中的 top 像素。
 *
 * - host 比可视区矮: 用 verticalOffset = (visible - host) 把 host 推到可视区底部, 模拟
 *   "fresh shell 内容贴底" 的终端心智。host 高于可视区时此偏移为 0, host 顶贴 spacer 顶,
 *   container.scrollTop 负责选哪几行可见。
 * - ydisp = buffer 中视窗第一行索引, 乘 cellH 得到 host 在 spacer 中的纵向 offset。
 * - 结果夹钳到 ≥ 0, 否则 host top 为负会让内容被 spacer 顶部裁掉。
 */
export function computeHostTop(input: HostTopInput): number {
  if (input.cellH <= 0) return 0;
  const hostHeight = input.rows * input.cellH;
  const verticalOffset =
    input.visibleContentHeight !== undefined && hostHeight < input.visibleContentHeight
      ? input.visibleContentHeight - hostHeight
      : 0;
  return Math.max(0, input.ydisp * input.cellH + verticalOffset);
}

/**
 * Projects the scrollback rows immediately before xterm's live viewport into
 * the otherwise unused space above a short, bottom-aligned server-owned PTY.
 *
 * This is derived rendering only: the remote rows, xterm viewport and semantic
 * scroll position stay unchanged. A fresh terminal without preceding history
 * deliberately keeps its normal top breathing room.
 */
export function computePtyLiveBackfill(input: HostTopInput): PtyLiveBackfillPlan | null {
  if (input.cellH <= 0 || input.rows <= 0 || input.ydisp <= 0) return null;
  const visibleContentHeight = Math.max(0, input.visibleContentHeight ?? 0);
  const hostHeight = input.rows * input.cellH;
  const gapHeight = Math.max(0, visibleContentHeight - hostHeight);
  if (gapHeight <= 0) return null;

  const requestedRows = Math.ceil(gapHeight / input.cellH);
  const rowCount = Math.min(requestedRows, Math.floor(input.ydisp));
  if (rowCount <= 0) return null;
  const endLine = Math.floor(input.ydisp) - 1;
  return {
    startLine: endLine - rowCount + 1,
    endLine,
    rowCount,
    rowHeight: input.cellH,
    topOffset: -rowCount * input.cellH,
  };
}

export function computeScrollTarget(scrollTop: number, metrics: PtyScrollMetrics): PtyScrollTarget {
  if (metrics.cellH <= 0) {
    return { ydisp: metrics.viewportY };
  }
  const maxYdisp = Math.max(0, metrics.bufferLength - metrics.rows);
  const pinnedMaxScrollTop = maxYdisp * metrics.cellH;
  if (scrollTop >= pinnedMaxScrollTop) {
    return { ydisp: maxYdisp };
  }
  const ydisp = Math.max(0, Math.floor(scrollTop / metrics.cellH));
  return { ydisp: Math.min(ydisp, maxYdisp) };
}

export function ydispToScrollTop(ydisp: number, cellH: number): number {
  if (cellH <= 0) return 0;
  return Math.max(0, ydisp) * cellH;
}
