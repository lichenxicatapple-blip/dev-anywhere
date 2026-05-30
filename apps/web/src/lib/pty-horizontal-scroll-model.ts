interface PtyHorizontalScrollState {
  intent: boolean;
  lastUserInputAt: number | null;
  unmarkedOriginLeft: number | null;
  lastSeenLeft: number;
  pendingFollowLeft: number | null;
}

export type PtyHorizontalScrollIntentTrace =
  | { kind: "set"; details: string }
  | { kind: "clear"; details: string }
  | { kind: "ignore"; details: string };

export function createInitialPtyHorizontalScrollState(): PtyHorizontalScrollState {
  return {
    intent: false,
    lastUserInputAt: null,
    unmarkedOriginLeft: null,
    lastSeenLeft: 0,
    pendingFollowLeft: null,
  };
}

function withIntent(state: PtyHorizontalScrollState, intent: boolean): PtyHorizontalScrollState {
  return {
    ...state,
    intent,
    unmarkedOriginLeft: intent ? state.unmarkedOriginLeft : null,
  };
}

export function clearPtyHorizontalIntent(
  state: PtyHorizontalScrollState,
  input: { details: string; scrollLeft?: number },
): { state: PtyHorizontalScrollState; trace: PtyHorizontalScrollIntentTrace | null } {
  const next = {
    ...withIntent(state, false),
    lastUserInputAt: null,
    pendingFollowLeft: null,
    ...(input.scrollLeft !== undefined ? { lastSeenLeft: input.scrollLeft } : {}),
  };
  return {
    state: next,
    trace: state.intent ? { kind: "clear", details: input.details } : null,
  };
}

export function markPtyHorizontalUserInput(
  state: PtyHorizontalScrollState,
  input: { now: number; details: string },
): { state: PtyHorizontalScrollState; trace: PtyHorizontalScrollIntentTrace | null } {
  const next = {
    ...state,
    intent: true,
    lastUserInputAt: input.now,
    unmarkedOriginLeft: null,
  };
  return {
    state: next,
    trace: state.intent ? null : { kind: "set", details: input.details },
  };
}

export function setPtyHorizontalPendingFollow(
  state: PtyHorizontalScrollState,
  pendingFollowLeft: number,
): PtyHorizontalScrollState {
  return { ...state, pendingFollowLeft };
}

export function reducePtyHorizontalContainerScroll(
  state: PtyHorizontalScrollState,
  input: {
    hasOverflow: boolean;
    scrollLeft: number;
    now: number;
    nativeIntentThresholdPx: number;
    pendingFollowTolerancePx?: number;
    recentUserInputMs?: number;
  },
): {
  state: PtyHorizontalScrollState;
  trace: PtyHorizontalScrollIntentTrace | null;
  resetScrollLeft: boolean;
} {
  if (!input.hasOverflow) {
    const cleared = clearPtyHorizontalIntent(state, {
      details: `reason=not-scrollable scrollLeft=${input.scrollLeft}`,
      scrollLeft: 0,
    });
    return { ...cleared, resetScrollLeft: input.scrollLeft !== 0 };
  }

  if (input.scrollLeft === state.lastSeenLeft) {
    return { state, trace: null, resetScrollLeft: false };
  }

  const pendingFollowTolerancePx = input.pendingFollowTolerancePx ?? 1;
  const recentUserInputMs = input.recentUserInputMs ?? 500;
  const isPendingFollow =
    state.pendingFollowLeft !== null &&
    Math.abs(input.scrollLeft - state.pendingFollowLeft) <= pendingFollowTolerancePx;

  if (isPendingFollow) {
    return {
      state: {
        ...state,
        pendingFollowLeft: null,
        unmarkedOriginLeft: null,
        lastSeenLeft: input.scrollLeft,
      },
      trace: null,
      resetScrollLeft: false,
    };
  }

  const hasRecentUserInput =
    state.lastUserInputAt !== null && input.now - state.lastUserInputAt <= recentUserInputMs;
  if (hasRecentUserInput) {
    const details = `site=onContainerScroll prev=${state.lastSeenLeft} next=${input.scrollLeft}`;
    return {
      state: {
        ...state,
        intent: true,
        pendingFollowLeft: null,
        unmarkedOriginLeft: null,
        lastSeenLeft: input.scrollLeft,
      },
      trace: state.intent ? null : { kind: "set", details },
      resetScrollLeft: false,
    };
  }

  const origin = state.unmarkedOriginLeft === null ? state.lastSeenLeft : state.unmarkedOriginLeft;
  const nativeDelta = Math.abs(input.scrollLeft - origin);
  if (nativeDelta >= input.nativeIntentThresholdPx) {
    const details = `site=onContainerScroll-native prev=${origin} next=${input.scrollLeft} delta=${nativeDelta}`;
    return {
      state: {
        ...state,
        intent: true,
        pendingFollowLeft: null,
        unmarkedOriginLeft: null,
        lastSeenLeft: input.scrollLeft,
      },
      trace: state.intent ? null : { kind: "set", details },
      resetScrollLeft: false,
    };
  }

  return {
    state: {
      ...state,
      pendingFollowLeft: null,
      unmarkedOriginLeft: origin,
      lastSeenLeft: input.scrollLeft,
    },
    trace: {
      kind: "ignore",
      details: `site=onContainerScroll prev=${state.lastSeenLeft} next=${input.scrollLeft} nativeDelta=${nativeDelta}`,
    },
    resetScrollLeft: false,
  };
}
