import { PTY_SCROLL_CONFIG } from "./pty-scroll-config";
import {
  computeTouchHorizontalExpectation,
  computeTouchMovement,
  computeTouchScrollExpectation,
  decideTouchGestureFinish,
} from "./pty-scroll-model";
import {
  beginPtyTouchScroll,
  createInitialPtyTouchScrollState,
  ensurePtyTouchPendingMode,
  markPtyTouchHorizontalGesture,
  markPtyTouchGesture,
  resetPtyTouchScrollSession,
  setPtyTouchGestureMode,
  updatePtyTouchMove,
  type PtyTouchScrollState,
} from "./pty-touch-scroll-state";
import type {
  PtyVerticalIntentEvent,
  PtyVerticalIntentResult,
  PtyVerticalIntentState,
} from "./pty-vertical-intent-fsm";

interface TouchAnchorSnapshot {
  isAtBottom: boolean;
  bottomScrollTop: number;
}

type TouchTrace = (event: string, extra?: { details?: string }) => void;

interface PtyTouchScrollHandlerOptions {
  container: HTMLDivElement;
  atBottomThreshold: number;
  trace: TouchTrace;
  getPageResumePending: () => boolean;
  getVerticalIntent: () => PtyVerticalIntentState;
  dispatchVerticalIntent: (event: PtyVerticalIntentEvent) => PtyVerticalIntentResult;
  getCurrentAnchor: () => TouchAnchorSnapshot;
  getBottomOverscrollPx?: () => number;
  getLastSeenScrollTop: () => number;
  hasHorizontalOverflow: () => boolean;
  clearHorizontalIntentIfUnscrollable: (site: string) => boolean;
  markHorizontalUserInput: (details: string) => void;
  onTouchBoundaryPrevent?: () => void;
  notifyAtBottom: () => void;
  flushPendingTouchScrollNotify: () => void;
}

interface PtyTouchScrollHandler {
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  isRecentNativeScroll: () => boolean;
  isRecentHorizontalGesture: () => boolean;
  getScrollExpectation: (
    currentYOverride?: number | null,
  ) => ReturnType<typeof computeTouchScrollExpectation>;
  describeScrollExpectation: (
    expectation: ReturnType<typeof computeTouchScrollExpectation>,
    rawScrollTop: number,
    effectiveScrollTop: number,
    previousScrollTop: number,
    verticalDelta: number,
  ) => string | null;
  getState: () => PtyTouchScrollState;
}

export function createPtyTouchScrollHandler({
  container,
  atBottomThreshold,
  trace,
  getPageResumePending,
  getVerticalIntent,
  dispatchVerticalIntent,
  getCurrentAnchor,
  getBottomOverscrollPx = () => 0,
  getLastSeenScrollTop,
  hasHorizontalOverflow,
  clearHorizontalIntentIfUnscrollable,
  markHorizontalUserInput,
  onTouchBoundaryPrevent,
  notifyAtBottom,
  flushPendingTouchScrollNotify,
}: PtyTouchScrollHandlerOptions): PtyTouchScrollHandler {
  let state = createInitialPtyTouchScrollState();

  const getScrollExpectation = (currentYOverride?: number | null) => {
    const currentY = currentYOverride ?? state.lastClientY;
    const anchor = getCurrentAnchor();
    const domMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const verticalIntent = getVerticalIntent();
    return computeTouchScrollExpectation({
      touchActive: verticalIntent.touchActive,
      touchStartScrollTop: verticalIntent.touchStartScrollTop,
      touchStartY: verticalIntent.touchStartY,
      currentY,
      touchStartedAtCursorAwareBottom: state.startedAtCursorAwareBottom,
      bottomScrollTop: anchor.bottomScrollTop + Math.max(0, getBottomOverscrollPx()),
      domMaxScrollTop,
    });
  };

  const getMovement = (currentX: number | null, currentY: number | null) =>
    computeTouchMovement({
      startX: state.startClientX,
      startY: getVerticalIntent().touchStartY,
      currentX,
      currentY,
    });

  const getHorizontalExpectation = (currentX: number | null) => {
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    return computeTouchHorizontalExpectation({
      touchActive: getVerticalIntent().touchActive,
      touchStartClientX: state.startClientX,
      touchStartScrollLeft: state.startScrollLeft,
      currentX,
      maxScrollLeft,
    });
  };

  const describeTouchScrollExpectation = (
    expectation: ReturnType<typeof getScrollExpectation>,
    rawScrollTop: number,
    effectiveScrollTop: number,
    previousScrollTop: number,
    verticalDelta: number,
  ): string | null => {
    if (!expectation) return null;
    return [
      `raw=${Math.round(rawScrollTop)}`,
      `effective=${Math.round(effectiveScrollTop)}`,
      `prev=${Math.round(previousScrollTop)}`,
      `delta=${Math.round(verticalDelta)}`,
      `expected=${Math.round(expectation.expectedScrollTop)}`,
      `startScroll=${Math.round(expectation.touchStartScrollTop)}`,
      `base=${Math.round(expectation.gestureBaseScrollTop)}`,
      `startY=${Math.round(expectation.touchStartY)}`,
      `currentY=${Math.round(expectation.currentY)}`,
      `touchDeltaY=${Math.round(expectation.touchDeltaY)}`,
      `max=${Math.round(expectation.cursorAwareMaxScrollTop)}`,
    ].join(" ");
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (getPageResumePending()) {
      trace("touchstart:page-resume-pending");
      return;
    }
    const touch = event.touches?.[0] ?? null;
    const startX = touch?.clientX ?? null;
    const startY = touch?.clientY ?? null;
    clearHorizontalIntentIfUnscrollable("touchstart");
    const anchor = getCurrentAnchor();
    state = beginPtyTouchScroll(state, {
      startedAtCursorAwareBottom: anchor.isAtBottom,
      startClientX: startX,
      startClientY: startY,
      startScrollLeft: container.scrollLeft,
      now: performance.now(),
    });
    dispatchVerticalIntent({
      type: "touch-start",
      clientY: startY,
      scrollTop: container.scrollTop,
    });
    trace("touchstart", {
      details: [
        `startX=${startX ?? "null"}`,
        `startY=${startY ?? "null"}`,
        `startScroll=${Math.round(container.scrollTop)}`,
        `bottom=${Math.round(anchor.bottomScrollTop)}`,
        `atBottom=${anchor.isAtBottom ? 1 : 0}`,
      ].join(" "),
    });
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (getPageResumePending()) {
      trace("touchmove:page-resume-pending");
      return;
    }
    const touch = event.touches?.[0] ?? null;
    const currentX = touch?.clientX ?? null;
    const currentY = touch?.clientY ?? null;
    const now = performance.now();
    state = updatePtyTouchMove(state, { currentY, now });
    const movement = getMovement(currentX, currentY);
    trace("touchmove", {
      details:
        currentY === null
          ? "currentY=null"
          : (describeTouchScrollExpectation(
              getScrollExpectation(currentY),
              container.scrollTop,
              container.scrollTop,
              getLastSeenScrollTop(),
              container.scrollTop - getLastSeenScrollTop(),
            ) ??
            [
              `mode=${state.gestureMode ?? "none"}`,
              `currentY=${Math.round(currentY)}`,
              movement
                ? `dx=${Math.round(movement.dx)} dy=${Math.round(movement.dy)} distance=${Math.round(movement.distance)}`
                : null,
            ]
              .filter(Boolean)
              .join(" ")),
    });

    const horizontallyScrollable = hasHorizontalOverflow();
    if (!horizontallyScrollable) {
      clearHorizontalIntentIfUnscrollable("touchmove");
    }

    state = ensurePtyTouchPendingMode(state, {
      touchActive: getVerticalIntent().touchActive,
      currentY,
    });

    if (state.gestureMode === "pending" && movement) {
      const horizontalDominates =
        horizontallyScrollable &&
        movement.absDx >= PTY_SCROLL_CONFIG.touch.horizontalGestureSlopPx &&
        movement.absDx > movement.absDy * PTY_SCROLL_CONFIG.touch.horizontalLockRatio;
      const verticalDominates =
        movement.absDy >= PTY_SCROLL_CONFIG.touch.gestureSlopPx &&
        (!horizontallyScrollable ||
          movement.absDy > movement.absDx * PTY_SCROLL_CONFIG.touch.verticalLockRatio);
      if (horizontalDominates) {
        state = setPtyTouchGestureMode(state, "horizontal");
        state = markPtyTouchHorizontalGesture(state, now);
        trace("touchmove:horizontal-lock", {
          details: `dx=${Math.round(movement.dx)} dy=${Math.round(movement.dy)} distance=${Math.round(movement.distance)}`,
        });
      } else if (!verticalDominates) {
        trace("touchmove:pending", {
          details: [
            `dx=${Math.round(movement.dx)}`,
            `dy=${Math.round(movement.dy)}`,
            `distance=${Math.round(movement.distance)}`,
            `hThreshold=${PTY_SCROLL_CONFIG.touch.horizontalGestureSlopPx}`,
            `vThreshold=${PTY_SCROLL_CONFIG.touch.gestureSlopPx}`,
          ].join(" "),
        });
        if (movement.absDy < PTY_SCROLL_CONFIG.touch.gestureSlopPx) {
          dispatchVerticalIntent({
            type: "touch-move",
            clientY: currentY,
            reviewThresholdPx: PTY_SCROLL_CONFIG.touch.gestureSlopPx,
          });
        }
        return;
      } else {
        state = setPtyTouchGestureMode(state, "vertical");
        trace("touchmove:vertical-lock", {
          details: `dx=${Math.round(movement.dx)} dy=${Math.round(movement.dy)} distance=${Math.round(movement.distance)} threshold=${PTY_SCROLL_CONFIG.touch.gestureSlopPx}`,
        });
      }
    }

    if (state.gestureMode === "horizontal") {
      const expectation = getHorizontalExpectation(currentX);
      if (!horizontallyScrollable || !expectation) {
        clearHorizontalIntentIfUnscrollable("touchmove-horizontal");
        trace("touchmove:horizontal-native", {
          details: movement
            ? `blocked dx=${Math.round(movement.dx)} dy=${Math.round(movement.dy)} distance=${Math.round(movement.distance)}`
            : "blocked movement=null",
        });
        return;
      }
      if (movement) {
        state = markPtyTouchHorizontalGesture(state, now);
        markHorizontalUserInput(
          `site=touchmove-horizontal dx=${Math.round(movement.absDx)} dy=${Math.round(movement.absDy)}`,
        );
      }
      trace("touchmove:horizontal-native", {
        details: [
          `scrollLeft=${Math.round(container.scrollLeft)}`,
          `expected=${Math.round(expectation.expectedScrollLeft)}`,
          `startScrollLeft=${Math.round(expectation.touchStartScrollLeft)}`,
          `startX=${Math.round(expectation.touchStartX)}`,
          `currentX=${Math.round(expectation.currentX)}`,
          `touchDeltaX=${Math.round(expectation.touchDeltaX)}`,
          `max=${Math.round(expectation.maxScrollLeft)}`,
        ].join(" "),
      });
      return;
    }

    if (state.gestureMode !== "vertical") {
      return;
    }

    const expectation = getScrollExpectation(currentY);
    if (expectation) {
      trace("touchmove:vertical-native", {
        details: [
          `scrollTop=${Math.round(container.scrollTop)}`,
          `expected=${Math.round(expectation.expectedScrollTop)}`,
          `startScroll=${Math.round(expectation.touchStartScrollTop)}`,
          `base=${Math.round(expectation.gestureBaseScrollTop)}`,
          `startY=${Math.round(expectation.touchStartY)}`,
          `currentY=${Math.round(expectation.currentY)}`,
          `touchDeltaY=${Math.round(expectation.touchDeltaY)}`,
        ].join(" "),
      });
    }
    const keepFollowingAtBottomBoundary =
      expectation &&
      state.startedAtCursorAwareBottom &&
      expectation.expectedScrollTop >= expectation.cursorAwareMaxScrollTop - atBottomThreshold &&
      currentY !== null &&
      currentY <= expectation.touchStartY;
    if (keepFollowingAtBottomBoundary) {
      trace("touchmove:bottom-boundary-follow");
      return;
    }

    const result = dispatchVerticalIntent({
      type: "touch-move",
      clientY: currentY,
      reviewThresholdPx: PTY_SCROLL_CONFIG.touch.gestureSlopPx,
    });
    if (result.notifyTouchReviewStart) {
      onTouchBoundaryPrevent?.();
      trace("touchmove:review");
    }
  };

  const finishTouchGesture = (type: "touch-end" | "touch-cancel"): void => {
    const liveScrollTop = container.scrollTop;
    const anchor = getCurrentAnchor();
    const finishDecision = decideTouchGestureFinish({
      touchStartScrollTop: getVerticalIntent().touchStartScrollTop,
      liveScrollTop,
      atBottomThreshold,
      touchStartedAtCursorAwareBottom: state.startedAtCursorAwareBottom,
      anchorIsAtBottom: anchor.isAtBottom,
      reviewedDuringTouch: getVerticalIntent().touchReviewNotified,
    });
    state = resetPtyTouchScrollSession(state);
    dispatchVerticalIntent({
      type,
      scrollTop: liveScrollTop,
      atCursorAwareBottom: finishDecision.atCursorAwareBottomForIntent,
      releaseOnSemanticBottom: finishDecision.releaseOnSemanticBottom,
    });
    state = markPtyTouchGesture(state, performance.now());
    flushPendingTouchScrollNotify();
    notifyAtBottom();
  };

  const onTouchEnd = (): void => {
    if (getPageResumePending()) {
      trace("touchend:page-resume-pending");
      return;
    }
    finishTouchGesture("touch-end");
    trace("touchend");
  };

  const onTouchCancel = (): void => {
    if (getPageResumePending()) {
      trace("touchcancel:page-resume-pending");
      return;
    }
    finishTouchGesture("touch-cancel");
    trace("touchcancel");
  };

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    isRecentNativeScroll: () =>
      getVerticalIntent().touchActive ||
      (state.lastGestureAt !== null &&
        performance.now() - state.lastGestureAt <= PTY_SCROLL_CONFIG.touch.nativeScrollRecentMs),
    isRecentHorizontalGesture: () =>
      state.lastHorizontalGestureAt !== null &&
      performance.now() - state.lastHorizontalGestureAt <=
        PTY_SCROLL_CONFIG.touch.nativeScrollRecentMs,
    getScrollExpectation,
    describeScrollExpectation: describeTouchScrollExpectation,
    getState: () => state,
  };
}
