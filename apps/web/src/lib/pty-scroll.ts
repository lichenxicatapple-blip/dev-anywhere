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
  subpixel: number;
}

export function computePtyHostLayout(
  metrics: PtyScrollMetrics,
  canvasLastY: number,
): PtyHostLayout | null {
  if (metrics.cellH <= 0 || metrics.cellW <= 0 || metrics.rows <= 0 || metrics.cols <= 0) {
    return null;
  }
  const blankRows = canvasLastY < 0 ? metrics.rows - 1 : metrics.rows - 1 - canvasLastY;
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
    return { ydisp: metrics.viewportY, subpixel: 0 };
  }
  const maxYdisp = Math.max(0, metrics.bufferLength - metrics.rows);
  const pinnedMaxScrollTop = maxYdisp * metrics.cellH;
  if (scrollTop >= pinnedMaxScrollTop) {
    return { ydisp: maxYdisp, subpixel: 0 };
  }
  const ydisp = Math.max(0, Math.floor(scrollTop / metrics.cellH));
  return {
    ydisp: Math.min(ydisp, maxYdisp),
    subpixel: scrollTop - ydisp * metrics.cellH,
  };
}

export function ydispToScrollTop(ydisp: number, cellH: number): number {
  if (cellH <= 0) return 0;
  return Math.max(0, ydisp) * cellH;
}
