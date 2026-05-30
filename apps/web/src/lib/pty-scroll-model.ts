type FollowCursorYDecision =
  | {
      action: "skip";
      reason: "intent" | "cellH=0" | "shortHost" | "same-row" | "inViewport" | "aligned";
      nextPrevCursorBufferRow: number | null;
      cursorDeltaRows: number | null;
    }
  | {
      action: "follow";
      reason: "cursor-outside";
      nextPrevCursorBufferRow: number;
      cursorDeltaRows: number | null;
      targetScrollTop: number;
    };

interface TouchMovementInput {
  startX: number | null;
  startY: number | null;
  currentX: number | null;
  currentY: number | null;
}

interface TouchMovement {
  dx: number;
  dy: number;
  absDx: number;
  absDy: number;
  distance: number;
  startY: number;
}

interface TouchScrollExpectationInput {
  touchActive: boolean;
  touchStartScrollTop: number | null;
  touchStartY: number | null;
  currentY: number | null;
  touchStartedAtCursorAwareBottom: boolean;
  bottomScrollTop: number;
  domMaxScrollTop: number;
}

interface TouchScrollExpectation {
  touchStartScrollTop: number;
  touchStartY: number;
  currentY: number;
  gestureBaseScrollTop: number;
  expectedScrollTop: number;
  cursorAwareMaxScrollTop: number;
  touchDeltaY: number;
}

interface TouchHorizontalExpectationInput {
  touchActive: boolean;
  touchStartClientX: number | null;
  touchStartScrollLeft: number | null;
  currentX: number | null;
  maxScrollLeft: number;
}

interface TouchHorizontalExpectation {
  touchStartX: number;
  currentX: number;
  touchStartScrollLeft: number;
  expectedScrollLeft: number;
  maxScrollLeft: number;
  touchDeltaX: number;
}

export function decideFollowCursorY({
  reviewing,
  cellH,
  rows,
  visibleContentHeight,
  cursorBufferRow,
  prevCursorBufferRow,
  cursorInViewport,
  targetScrollTop,
  currentScrollTop,
}: {
  reviewing: boolean;
  cellH: number;
  rows: number;
  visibleContentHeight: number;
  cursorBufferRow: number;
  prevCursorBufferRow: number | null;
  cursorInViewport: boolean;
  targetScrollTop: number;
  currentScrollTop: number;
}): FollowCursorYDecision {
  if (reviewing) {
    return {
      action: "skip",
      reason: "intent",
      nextPrevCursorBufferRow: null,
      cursorDeltaRows: null,
    };
  }
  if (cellH <= 0) {
    return {
      action: "skip",
      reason: "cellH=0",
      nextPrevCursorBufferRow: prevCursorBufferRow,
      cursorDeltaRows: null,
    };
  }
  if (rows * cellH <= visibleContentHeight) {
    return {
      action: "skip",
      reason: "shortHost",
      nextPrevCursorBufferRow: null,
      cursorDeltaRows: null,
    };
  }
  if (prevCursorBufferRow === cursorBufferRow && cursorInViewport) {
    return {
      action: "skip",
      reason: "same-row",
      nextPrevCursorBufferRow: prevCursorBufferRow,
      cursorDeltaRows: 0,
    };
  }

  const cursorDeltaRows =
    prevCursorBufferRow === null ? null : cursorBufferRow - prevCursorBufferRow;
  if (cursorInViewport) {
    return {
      action: "skip",
      reason: "inViewport",
      nextPrevCursorBufferRow: cursorBufferRow,
      cursorDeltaRows,
    };
  }
  if (Math.abs(targetScrollTop - currentScrollTop) <= 1) {
    return {
      action: "skip",
      reason: "aligned",
      nextPrevCursorBufferRow: cursorBufferRow,
      cursorDeltaRows,
    };
  }
  return {
    action: "follow",
    reason: "cursor-outside",
    nextPrevCursorBufferRow: cursorBufferRow,
    cursorDeltaRows,
    targetScrollTop,
  };
}

export function computeTouchMovement({
  startX,
  startY,
  currentX,
  currentY,
}: TouchMovementInput): TouchMovement | null {
  if (startY === null || currentY === null) return null;
  const dx = startX !== null && currentX !== null ? currentX - startX : 0;
  const dy = currentY - startY;
  return {
    dx,
    dy,
    absDx: Math.abs(dx),
    absDy: Math.abs(dy),
    distance: Math.hypot(dx, dy),
    startY,
  };
}

export function computeTouchScrollExpectation({
  touchActive,
  touchStartScrollTop,
  touchStartY,
  currentY,
  touchStartedAtCursorAwareBottom,
  bottomScrollTop,
  domMaxScrollTop,
}: TouchScrollExpectationInput): TouchScrollExpectation | false {
  if (!touchActive) return false;
  if (touchStartScrollTop === null || touchStartY === null || currentY === null) return false;

  const cursorAwareMaxScrollTop = Math.min(domMaxScrollTop, bottomScrollTop);
  const gestureBaseScrollTop = touchStartedAtCursorAwareBottom
    ? bottomScrollTop
    : touchStartScrollTop;
  const expectedScrollTop = Math.max(
    0,
    Math.min(cursorAwareMaxScrollTop, gestureBaseScrollTop + (touchStartY - currentY)),
  );

  return {
    touchStartScrollTop,
    touchStartY,
    currentY,
    gestureBaseScrollTop,
    expectedScrollTop,
    cursorAwareMaxScrollTop,
    touchDeltaY: currentY - touchStartY,
  };
}

export function computeTouchHorizontalExpectation({
  touchActive,
  touchStartClientX,
  touchStartScrollLeft,
  currentX,
  maxScrollLeft,
}: TouchHorizontalExpectationInput): TouchHorizontalExpectation | false {
  if (!touchActive) return false;
  if (touchStartClientX === null || touchStartScrollLeft === null || currentX === null) {
    return false;
  }

  const expectedScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, touchStartScrollLeft + (touchStartClientX - currentX)),
  );

  return {
    touchStartX: touchStartClientX,
    currentX,
    touchStartScrollLeft,
    expectedScrollLeft,
    maxScrollLeft,
    touchDeltaX: currentX - touchStartClientX,
  };
}

export function decideTouchGestureFinish({
  touchStartScrollTop,
  liveScrollTop,
  atBottomThreshold,
  touchStartedAtCursorAwareBottom,
  anchorIsAtBottom,
  reviewedDuringTouch,
}: {
  touchStartScrollTop: number | null;
  liveScrollTop: number;
  atBottomThreshold: number;
  touchStartedAtCursorAwareBottom: boolean;
  anchorIsAtBottom: boolean;
  reviewedDuringTouch: boolean;
}): { atCursorAwareBottomForIntent: boolean; releaseOnSemanticBottom: boolean } {
  const stayedNearTouchStart =
    touchStartScrollTop === null || liveScrollTop >= touchStartScrollTop - atBottomThreshold;
  const releaseOnSemanticBottom =
    touchStartedAtCursorAwareBottom && anchorIsAtBottom && !reviewedDuringTouch;
  const atCursorAwareBottomForIntent =
    (!reviewedDuringTouch && anchorIsAtBottom) ||
    (touchStartedAtCursorAwareBottom && !reviewedDuringTouch && stayedNearTouchStart);
  return { atCursorAwareBottomForIntent, releaseOnSemanticBottom };
}
