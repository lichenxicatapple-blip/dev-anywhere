interface PtySelectionToolbarPositionInput {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportOffsetLeft?: number;
  viewportOffsetTop?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

const TOOLBAR_EDGE_PADDING = 64;

export function computePtySelectionToolbarPosition({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
  viewportOffsetLeft = 0,
  viewportOffsetTop = 0,
}: PtySelectionToolbarPositionInput): { left: number; top: number } {
  const minLeft = viewportOffsetLeft + 56;
  const maxLeft = viewportOffsetLeft + viewportWidth - 56;
  const minTop = viewportOffsetTop + 56;
  const maxTop = viewportOffsetTop + viewportHeight - TOOLBAR_EDGE_PADDING;
  return {
    left: clamp(clientX, minLeft, maxLeft),
    top: clamp(clientY - 48, minTop, maxTop),
  };
}
