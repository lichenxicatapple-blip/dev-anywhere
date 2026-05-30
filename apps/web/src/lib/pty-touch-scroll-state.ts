export type TouchScrollGestureMode = "pending" | "vertical" | "horizontal";

export interface PtyTouchScrollState {
  startedAtCursorAwareBottom: boolean;
  startClientX: number | null;
  startScrollLeft: number | null;
  lastClientY: number | null;
  lastGestureAt: number | null;
  gestureMode: TouchScrollGestureMode | null;
}

export function createInitialPtyTouchScrollState(): PtyTouchScrollState {
  return {
    startedAtCursorAwareBottom: false,
    startClientX: null,
    startScrollLeft: null,
    lastClientY: null,
    lastGestureAt: null,
    gestureMode: null,
  };
}

export function beginPtyTouchScroll(
  state: PtyTouchScrollState,
  input: {
    startedAtCursorAwareBottom: boolean;
    startClientX: number | null;
    startClientY: number | null;
    startScrollLeft: number;
    now: number;
  },
): PtyTouchScrollState {
  return {
    ...state,
    startedAtCursorAwareBottom: input.startedAtCursorAwareBottom,
    startClientX: input.startClientX,
    startScrollLeft: input.startScrollLeft,
    lastClientY: input.startClientY,
    lastGestureAt: input.now,
    gestureMode: input.startClientY === null ? null : "pending",
  };
}

export function markPtyTouchGesture(state: PtyTouchScrollState, now: number): PtyTouchScrollState {
  return {
    ...state,
    lastGestureAt: now,
  };
}

export function updatePtyTouchMove(
  state: PtyTouchScrollState,
  input: { currentY: number | null; now: number },
): PtyTouchScrollState {
  return {
    ...state,
    lastClientY: input.currentY,
    lastGestureAt: input.now,
  };
}

export function ensurePtyTouchPendingMode(
  state: PtyTouchScrollState,
  input: { touchActive: boolean; currentY: number | null },
): PtyTouchScrollState {
  if (!input.touchActive || state.gestureMode !== null || input.currentY === null) return state;
  return { ...state, gestureMode: "pending" };
}

export function setPtyTouchGestureMode(
  state: PtyTouchScrollState,
  gestureMode: TouchScrollGestureMode,
): PtyTouchScrollState {
  if (state.gestureMode === gestureMode) return state;
  return { ...state, gestureMode };
}

export function resetPtyTouchScrollSession(state: PtyTouchScrollState): PtyTouchScrollState {
  return {
    ...state,
    startedAtCursorAwareBottom: false,
    startClientX: null,
    startScrollLeft: null,
    lastClientY: null,
    gestureMode: null,
  };
}
