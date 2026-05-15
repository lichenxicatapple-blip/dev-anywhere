interface PtyScrollMetrics {
  bufferLength: number;
  rows: number;
  cols: number;
  viewportY: number;
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

interface PtyScrollTarget {
  ydisp: number;
}

export function computePtyHostLayout(
  metrics: PtyScrollMetrics,
  canvasLastY: number,
): PtyHostLayout | null {
  if (metrics.cellH <= 0 || metrics.cellW <= 0 || metrics.rows <= 0 || metrics.cols <= 0) {
    return null;
  }
  // hostPaddingTop 仅在冷启动 (bufferLength <= rows) 场景使用——此时整屏多数是空,
  // padding 把仅有的几行内容顶到屏幕底部, 视觉上模拟终端 "fill from bottom" 行为。
  // 长会话 (bufferLength > rows) 已进入 scrollback 区, 光标上方都是有效 buffer 行,
  // 光标下方的空行属于"光标余空"; 这时再加 paddingTop 会把 host 内容整体下推,
  // 与 positionHostAt 给出的 host.top (按 ydisp*cellH 算) 拼起来在视窗顶部留出
  // 与 padding 等高的黑带, 即 blank-render 现场 (#docs/known-issues/pty-blank-render.md)。
  //
  // padding 底参考: 当 rows*cellH > visibleContentHeight (窄高度终端 / 移动端) 时,
  // 仅 host 顶部 visible 高度可见, padding 必须夹到 visible, 否则内容被压到截断点之下看不见。
  const hostHeight = metrics.rows * metrics.cellH;
  const isColdStart = metrics.bufferLength <= metrics.rows;
  const visibleContentHeight = Math.max(0, metrics.visibleContentHeight ?? 0);
  const paddingBottomReference =
    visibleContentHeight > 0 ? Math.min(hostHeight, visibleContentHeight) : hostHeight;
  const rowsOfContent = canvasLastY < 0 ? 1 : Math.max(1, canvasLastY + 1);
  const hostPaddingTop = isColdStart
    ? Math.max(0, paddingBottomReference - rowsOfContent * metrics.cellH)
    : 0;
  const maxYdisp = Math.max(0, metrics.bufferLength - metrics.rows);
  const minSpacerHeightForLastViewport = maxYdisp * metrics.cellH + visibleContentHeight;
  return {
    spacerHeight: Math.max(metrics.bufferLength * metrics.cellH, minSpacerHeightForLastViewport),
    spacerWidth: metrics.cols * metrics.cellW,
    hostWidth: metrics.cols * metrics.cellW,
    hostHeight,
    hostPaddingTop,
  };
}

interface ScrollAnchorInput {
  rows: number;
  cellH: number;
  bufferLength: number;
  // 光标在 live buffer 中的绝对行 (term.buffer.active.baseY + .cursorY)。
  // viewportY 会随用户回看历史变化，不能用来定位 live cursor；否则回看时会把
  // 光标错误投影到历史视窗里，让 cursor-aware atBottom 误判为 true。
  cursorBufferRow: number;
  // container.clientHeight 扣掉上下 padding
  visibleContentHeight: number;
  // container 自身的 padding-top, 用于把 buffer 行像素和 scrollTop 坐标对齐
  paddingTop: number;
  paddingBottom: number;
  containerScrollTop: number;
  containerScrollHeight: number;
  containerClientHeight: number;
  atBottomThreshold: number;
}

interface ScrollAnchorOutput {
  isAtBottom: boolean;
  // 用户点 "back to bottom" 或程序触发 scrollToBottom 时容器应该被设到的 scrollTop
  bottomScrollTop: number;
  cursorInViewport: boolean;
}

/**
 * 一次算出"几何贴底"和"光标可见"两件事。controller 之前两个方法各自做局部条件判断,
 * 这里集中: host 高度跟可视区比较的分支只在这一处出现, 之后任何 anchor 类决策只走这条路。
 *
 * - host ≤ visible (短 host): 整个 host 在视窗内, 几何 scrollTop 贴底就能看到光标行,
 *   isAtBottom = scrollTop+clientHeight >= scrollHeight - threshold (老语义)。
 * - host > visible (长 host, 移动端 / 高 rows): buffer 末尾常是 trailing empty,
 *   几何贴底反而看不到内容; 此时锚定光标——isAtBottom = 光标像素落在视窗内,
 *   bottomScrollTop 把光标行像素居中放进视窗。
 */
export function computeScrollAnchor(input: ScrollAnchorInput): ScrollAnchorOutput {
  const cursorPx = input.paddingTop + input.cursorBufferRow * input.cellH;
  const viewportTop = input.containerScrollTop + input.paddingTop;
  const viewportBottom =
    input.containerScrollTop + input.containerClientHeight - input.paddingBottom;
  const cursorInViewport =
    input.cellH > 0 && cursorPx >= viewportTop && cursorPx + input.cellH <= viewportBottom;

  const maxScrollTop = Math.max(0, input.containerScrollHeight - input.containerClientHeight);
  const hostHeight = input.rows * input.cellH;
  const longHost = input.cellH > 0 && hostHeight > input.visibleContentHeight;

  let isAtBottom: boolean;
  let bottomScrollTop: number;
  if (longHost) {
    isAtBottom = cursorInViewport;
    const target = cursorPx - input.paddingTop - (input.visibleContentHeight - input.cellH) / 2;
    const maxYdisp = Math.max(0, input.bufferLength - input.rows);
    const minScrollTop = maxYdisp * input.cellH;
    bottomScrollTop = Math.max(minScrollTop, Math.min(maxScrollTop, target));
  } else {
    isAtBottom =
      input.containerScrollTop + input.containerClientHeight >=
      input.containerScrollHeight - input.atBottomThreshold;
    bottomScrollTop = maxScrollTop;
  }
  return { isAtBottom, bottomScrollTop, cursorInViewport };
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
