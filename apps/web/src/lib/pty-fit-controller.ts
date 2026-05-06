import type { Terminal } from "@xterm/xterm";

interface PtyFontSizeOptions {
  minFontSize?: number;
  maxFontSize?: number;
  widthCellRatio?: number;
  heightCellRatio?: number;
}

interface PtyFitControllerOptions extends PtyFontSizeOptions {
  container: HTMLDivElement;
  term: Terminal;
  enabled: boolean;
  defaultFontSize?: number;
  onRelayout?: () => void;
}

interface PtyFitController {
  dispose: () => void;
}

export function computePtyFontSize(
  containerWidth: number,
  containerHeight: number,
  cols: number,
  rows: number,
  options: PtyFontSizeOptions = {},
): number | null {
  if (!containerWidth || !containerHeight || !cols || !rows) return null;
  const {
    minFontSize = 8,
    maxFontSize = 16,
    widthCellRatio = 0.6,
    heightCellRatio = 1.2,
  } = options;
  const byWidth = containerWidth / cols / widthCellRatio;
  const byHeight = containerHeight / rows / heightCellRatio;
  return Math.max(minFontSize, Math.min(maxFontSize, Math.floor(Math.min(byWidth, byHeight))));
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

export function attachPtyFitController(options: PtyFitControllerOptions): PtyFitController {
  const {
    container,
    term,
    enabled,
    defaultFontSize = 14,
    onRelayout,
    minFontSize,
    maxFontSize,
    widthCellRatio,
    heightCellRatio,
  } = options;

  const applyFontSize = (next: number): void => {
    if (term.options.fontSize === next) return;
    term.options.fontSize = next;
    term.refresh(0, term.rows - 1);
    requestAnimationFrame(() => onRelayout?.());
  };

  const fit = (): void => {
    if (!enabled) {
      applyFontSize(defaultFontSize);
      return;
    }

    const available = getAvailableContainerSize(container);
    const next = computePtyFontSize(available.width, available.height, term.cols, term.rows, {
      minFontSize,
      maxFontSize,
      widthCellRatio,
      heightCellRatio,
    });
    if (next !== null) applyFontSize(next);
  };

  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(container);

  return {
    dispose: () => ro.disconnect(),
  };
}
