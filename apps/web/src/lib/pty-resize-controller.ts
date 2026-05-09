import type { Terminal } from "@xterm/xterm";

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
  const px = (value: string): number => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    width: Math.max(0, container.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
    height: Math.max(0, container.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
  };
}

function measureCellSize(term: Terminal): { width: number; height: number } | null {
  const root = term.element;
  const screen = root?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return null;
  return {
    width: screen.clientWidth / term.cols,
    height: screen.clientHeight / term.rows,
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
    const cell = measureCellSize(term);
    if (!cell) return;
    const next = computePtyGeometry(available.width, available.height, cell.width, cell.height, {
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

  return {
    dispose: () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
    },
  };
}
