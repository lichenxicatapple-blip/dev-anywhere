import type { Terminal } from "@xterm/xterm";
import { parsePx } from "./pty-style-utils";
import { measureXtermCellSize } from "./pty-xterm-metrics";

interface PtyResizeControllerOptions {
  container: HTMLDivElement;
  term: Terminal;
  onResize: (cols: number, rows: number) => void;
  onRelayout?: () => void;
  minCols?: number;
  minRows?: number;
}

interface PtyResizeController {
  dispose: () => void;
}

export function computePtyGeometry(
  containerWidth: number,
  containerHeight: number,
  cellWidth: number,
  cellHeight: number,
  options: { minCols?: number; minRows?: number } = {},
): { cols: number; rows: number } | null {
  if (containerWidth <= 0 || containerHeight <= 0 || cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }
  return {
    cols: Math.max(options.minCols ?? 20, Math.floor(containerWidth / cellWidth)),
    rows: Math.max(options.minRows ?? 8, Math.floor(containerHeight / cellHeight)),
  };
}

function getAvailableContainerSize(container: HTMLDivElement): {
  width: number;
  height: number;
} {
  const style = getComputedStyle(container);
  return {
    width: Math.max(
      0,
      container.clientWidth - parsePx(style.paddingLeft) - parsePx(style.paddingRight),
    ),
    height: Math.max(
      0,
      container.clientHeight - parsePx(style.paddingTop) - parsePx(style.paddingBottom),
    ),
  };
}

export function attachPtyResizeController(
  options: PtyResizeControllerOptions,
): PtyResizeController {
  const { container, term, onResize, onRelayout, minCols, minRows } = options;
  let disposed = false;
  let frame: number | null = null;

  const fit = (): void => {
    frame = null;
    if (disposed) return;
    const available = getAvailableContainerSize(container);
    const root = term.element;
    if (!root) return;
    const cell = measureXtermCellSize(root, term);
    if (!cell) return;
    const next = computePtyGeometry(available.width, available.height, cell.cellW, cell.cellH, {
      minCols,
      minRows,
    });
    if (!next || (next.cols === term.cols && next.rows === term.rows)) return;
    term.resize(next.cols, next.rows);
    onResize(next.cols, next.rows);
    requestAnimationFrame(() => {
      if (!disposed) onRelayout?.();
    });
  };

  const scheduleFit = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(fit);
  };

  scheduleFit();
  const ro = new ResizeObserver(scheduleFit);
  ro.observe(container);
  // iOS 地址栏折叠 / Android 软键盘弹出会改 visualViewport / window 尺寸, 但 flex 容器
  // 的 clientHeight 在 layout 安顿前可能滞后, ResizeObserver 不一定立即触发。订阅 window
  // resize + visualViewport resize 作兜底, scheduleFit 自身 idempotent (RAF 合并)。
  const onWindowResize = scheduleFit;
  window.addEventListener("resize", onWindowResize);
  const visualViewport = window.visualViewport;
  visualViewport?.addEventListener("resize", onWindowResize);

  return {
    dispose: () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
      visualViewport?.removeEventListener("resize", onWindowResize);
    },
  };
}
