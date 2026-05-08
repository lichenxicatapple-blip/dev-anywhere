import type { Terminal } from "@xterm/xterm";

interface PtyFontSizeOptions {
  minFontSize?: number;
  maxFontSize?: number;
  widthCellRatio?: number;
}

interface PtyFontSizeApplyOptions extends PtyFontSizeOptions {
  container: HTMLDivElement;
  term: Terminal;
  onRelayout?: () => void;
}

export function applyPtyFontSize(term: Terminal, next: number, onRelayout?: () => void): boolean {
  if (term.options.fontSize === next) return false;
  term.options.fontSize = next;
  term.resize(term.cols, term.rows);
  term.refresh(0, term.rows - 1);
  requestAnimationFrame(() => onRelayout?.());
  return true;
}

export function computePtyFontSize(
  containerWidth: number,
  _containerHeight: number,
  cols: number,
  _rows: number,
  options: PtyFontSizeOptions = {},
): number | null {
  if (!containerWidth || !cols) return null;
  const { minFontSize = 8, maxFontSize = 16, widthCellRatio = 0.6 } = options;
  const byWidth = containerWidth / cols / widthCellRatio;
  return Math.max(minFontSize, Math.min(maxFontSize, Math.floor(byWidth)));
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
  const horizontalPadding = px(style.paddingLeft) + px(style.paddingRight);
  const verticalPadding = px(style.paddingTop) + px(style.paddingBottom);
  return {
    width: Math.max(0, container.clientWidth - horizontalPadding),
    height: Math.max(0, container.clientHeight - verticalPadding),
  };
}

export function fitPtyFontSizeOnce(options: PtyFontSizeApplyOptions): number | null {
  const { container, term, onRelayout, minFontSize, maxFontSize, widthCellRatio } = options;
  const available = getAvailableContainerSize(container);
  const next = computePtyFontSize(available.width, available.height, term.cols, term.rows, {
    minFontSize,
    maxFontSize,
    widthCellRatio,
  });
  if (next !== null) {
    applyPtyFontSize(term, next, onRelayout);
  }
  return next;
}
