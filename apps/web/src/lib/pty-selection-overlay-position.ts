interface PtySelectionToolbarPositionInput {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportOffsetLeft?: number;
  viewportOffsetTop?: number;
}

interface PtySelectionScrollDismissInput {
  now: number;
  viewportTransitionUntil: number;
  scrollLeft: number;
  scrollTop: number;
  selectionAutoscrollPosition: { scrollLeft: number; scrollTop: number } | null;
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

export function shouldDismissPtySelectionOnContainerScroll({
  now,
  viewportTransitionUntil,
  scrollLeft,
  scrollTop,
  selectionAutoscrollPosition,
}: PtySelectionScrollDismissInput): boolean {
  if (now <= viewportTransitionUntil) return false;
  return !(
    selectionAutoscrollPosition &&
    scrollLeft === selectionAutoscrollPosition.scrollLeft &&
    scrollTop === selectionAutoscrollPosition.scrollTop
  );
}
