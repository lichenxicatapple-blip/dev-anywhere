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
  const isColdStart = metrics.bufferLength <= metrics.rows;
  const blankRows = isColdStart
    ? canvasLastY < 0
      ? metrics.rows - 1
      : metrics.rows - 1 - canvasLastY
    : 0;
  const hostHeight = metrics.rows * metrics.cellH;
  const maxYdisp = Math.max(0, metrics.bufferLength - metrics.rows);
  const visibleContentHeight = Math.max(0, metrics.visibleContentHeight ?? 0);
  const minSpacerHeightForLastViewport = maxYdisp * metrics.cellH + visibleContentHeight;
  return {
    spacerHeight: Math.max(metrics.bufferLength * metrics.cellH, minSpacerHeightForLastViewport),
    spacerWidth: metrics.cols * metrics.cellW,
    hostWidth: metrics.cols * metrics.cellW,
    hostHeight,
    hostPaddingTop: Math.max(0, blankRows) * metrics.cellH,
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
