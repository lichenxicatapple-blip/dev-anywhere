export type PtyVerticalIntentMode = "following" | "reviewing";

export type PtyVerticalIntentSource =
  | "none"
  | "initial"
  | "wheel"
  | "native-scroll"
  | "touch"
  | "ratio-scroll"
  | "programmatic-bottom";

export const PTY_VERTICAL_INTENT_TRANSITION_IDS = [
  "attach.following",
  "attach.reviewing",
  "bottom.passive.reviewing",
  "bottom.passive.following",
  "bottom.force",
  "ratio.reviewing",
  "wheel.clamped",
  "wheel.up",
  "wheel.down.not-bottom",
  "wheel.down.bottom",
  "container.programmatic-follow",
  "container.programmatic-bottom",
  "container.external-sync",
  "container.user.away",
  "container.user.bottom-small-delta",
  "container.user.bottom-down",
  "touch.start",
  "touch.move.below-threshold",
  "touch.move.review",
  "touch.end.not-bottom",
  "touch.end.bottom-down",
  "touch.cancel.not-bottom",
  "touch.cancel.bottom-down",
] as const;

export type PtyVerticalIntentTransitionId = (typeof PTY_VERTICAL_INTENT_TRANSITION_IDS)[number];

export interface PtyVerticalIntentState {
  mode: PtyVerticalIntentMode;
  source: PtyVerticalIntentSource;
  touchActive: boolean;
  touchStartY: number | null;
  touchStartScrollTop: number | null;
  touchReviewNotified: boolean;
  lastScrollTop: number;
  lastTransitionId: PtyVerticalIntentTransitionId;
}

export type PtyVerticalIntentEvent =
  | { type: "attach"; initialIntent: boolean; scrollTop: number }
  | { type: "scroll-to-bottom"; force: boolean; reason: string }
  | { type: "scroll-to-ratio"; ratio: number; scrollTop: number }
  | {
      type: "wheel";
      deltaY: number;
      previousScrollTop: number;
      nextScrollTop: number;
      reachedCursorAwareBottom: boolean;
    }
  | {
      type: "container-scroll";
      source: "user" | "programmatic-follow" | "programmatic-bottom" | "external-sync";
      scrollTop: number;
      atCursorAwareBottom: boolean;
      verticalDelta: number;
    }
  | { type: "touch-start"; clientY: number | null; scrollTop: number }
  | { type: "touch-move"; clientY: number | null; reviewThresholdPx: number }
  | { type: "touch-end"; scrollTop: number; atCursorAwareBottom: boolean }
  | { type: "touch-cancel"; scrollTop: number; atCursorAwareBottom: boolean };

export interface PtyVerticalIntentResult {
  state: PtyVerticalIntentState;
  changed: boolean;
  outputPausedChanged: boolean;
  notifyTouchReviewStart: boolean;
  trace?: {
    id: PtyVerticalIntentTransitionId;
    action: "set" | "clear" | "keep";
    reason: string;
  };
}

export interface PtyVerticalIntentReduceOptions {
  atBottomThreshold?: number;
}

export function createInitialPtyVerticalIntentState(options?: {
  initialIntent?: boolean;
  scrollTop?: number;
}): PtyVerticalIntentState {
  const mode: PtyVerticalIntentMode = options?.initialIntent ? "reviewing" : "following";
  return {
    mode,
    source: options?.initialIntent ? "initial" : "none",
    touchActive: false,
    touchStartY: null,
    touchStartScrollTop: null,
    touchReviewNotified: false,
    lastScrollTop: options?.scrollTop ?? 0,
    lastTransitionId: options?.initialIntent ? "attach.reviewing" : "attach.following",
  };
}

export const isReviewing = (state: PtyVerticalIntentState): boolean => state.mode === "reviewing";

export const canPassiveFollow = (state: PtyVerticalIntentState): boolean =>
  state.mode === "following";

export const shouldPauseOutput = isReviewing;

function actionFor(
  previous: PtyVerticalIntentMode,
  next: PtyVerticalIntentMode,
): "set" | "clear" | "keep" {
  if (previous === "following" && next === "reviewing") return "set";
  if (previous === "reviewing" && next === "following") return "clear";
  return "keep";
}

function finish(
  previous: PtyVerticalIntentState,
  next: PtyVerticalIntentState,
  reason: string,
  notifyTouchReviewStart = false,
): PtyVerticalIntentResult {
  const outputPausedChanged = previous.mode !== next.mode;
  return {
    state: next,
    changed: previous !== next,
    outputPausedChanged,
    notifyTouchReviewStart,
    trace: {
      id: next.lastTransitionId,
      action: actionFor(previous.mode, next.mode),
      reason,
    },
  };
}

function withReview(
  state: PtyVerticalIntentState,
  source: PtyVerticalIntentSource,
  lastScrollTop: number,
  transitionId: PtyVerticalIntentTransitionId,
): PtyVerticalIntentState {
  return {
    ...state,
    mode: "reviewing",
    source,
    lastScrollTop,
    lastTransitionId: transitionId,
  };
}

function withFollowing(
  state: PtyVerticalIntentState,
  source: PtyVerticalIntentSource,
  lastScrollTop: number,
  transitionId: PtyVerticalIntentTransitionId,
): PtyVerticalIntentState {
  return {
    ...state,
    mode: "following",
    source,
    lastScrollTop,
    lastTransitionId: transitionId,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled PTY vertical intent event: ${JSON.stringify(value)}`);
}

function finishTouchGesture(
  state: PtyVerticalIntentState,
  event: Extract<PtyVerticalIntentEvent, { type: "touch-end" | "touch-cancel" }>,
  atBottomThreshold: number,
): PtyVerticalIntentResult {
  const transitionPrefix = event.type === "touch-end" ? "touch.end" : "touch.cancel";
  const movedDown =
    state.touchStartScrollTop !== null && event.scrollTop > state.touchStartScrollTop;
  const stillAtTouchStartBottom =
    state.touchStartScrollTop === null ||
    event.scrollTop >= state.touchStartScrollTop - atBottomThreshold;
  const base = {
    ...state,
    touchActive: false,
    touchStartY: null,
    touchStartScrollTop: null,
    touchReviewNotified: false,
    lastScrollTop: event.scrollTop,
  };
  if (
    state.mode === "reviewing" &&
    event.atCursorAwareBottom &&
    (movedDown || stillAtTouchStartBottom)
  ) {
    return finish(
      state,
      {
        ...base,
        mode: "following",
        source: "none",
        lastTransitionId: `${transitionPrefix}.bottom-down`,
      },
      `scrollTop=${event.scrollTop} atBottom=true`,
    );
  }
  return finish(
    state,
    {
      ...base,
      lastTransitionId: `${transitionPrefix}.not-bottom`,
    },
    `scrollTop=${event.scrollTop} atBottom=${event.atCursorAwareBottom}`,
  );
}

export function reducePtyVerticalIntent(
  state: PtyVerticalIntentState,
  event: PtyVerticalIntentEvent,
  options: PtyVerticalIntentReduceOptions = {},
): PtyVerticalIntentResult {
  const atBottomThreshold = options.atBottomThreshold ?? 8;
  switch (event.type) {
    case "attach": {
      const next = createInitialPtyVerticalIntentState({
        initialIntent: event.initialIntent,
        scrollTop: event.scrollTop,
      });
      return finish(state, next, `initialIntent=${event.initialIntent}`);
    }
    case "scroll-to-bottom": {
      if (!event.force) {
        return finish(
          state,
          { ...state, lastTransitionId: `bottom.passive.${state.mode}` },
          `reason=${event.reason} force=false`,
        );
      }
      return finish(
        state,
        withFollowing(
          {
            ...state,
            touchActive: false,
            touchStartY: null,
            touchStartScrollTop: null,
            touchReviewNotified: false,
          },
          "programmatic-bottom",
          state.lastScrollTop,
          "bottom.force",
        ),
        `reason=${event.reason} force=true`,
      );
    }
    case "scroll-to-ratio": {
      return finish(
        state,
        withReview(state, "ratio-scroll", event.scrollTop, "ratio.reviewing"),
        `ratio=${event.ratio}`,
      );
    }
    case "wheel": {
      if (event.nextScrollTop === event.previousScrollTop) {
        return finish(
          state,
          { ...state, lastTransitionId: "wheel.clamped", lastScrollTop: event.nextScrollTop },
          `delta=${event.deltaY}`,
        );
      }
      if (event.deltaY < 0) {
        return finish(
          state,
          withReview(state, "wheel", event.nextScrollTop, "wheel.up"),
          `delta=${event.deltaY}`,
        );
      }
      if (event.deltaY > 0 && event.reachedCursorAwareBottom) {
        return finish(
          state,
          withFollowing(state, "none", event.nextScrollTop, "wheel.down.bottom"),
          `delta=${event.deltaY}`,
        );
      }
      return finish(
        state,
        withReview(state, "wheel", event.nextScrollTop, "wheel.down.not-bottom"),
        `delta=${event.deltaY}`,
      );
    }
    case "container-scroll": {
      if (event.source !== "user") {
        return finish(
          state,
          {
            ...state,
            lastScrollTop: event.scrollTop,
            lastTransitionId: `container.${event.source}`,
          },
          `source=${event.source} scrollTop=${event.scrollTop}`,
        );
      }
      if (!event.atCursorAwareBottom) {
        return finish(
          state,
          withReview(state, "native-scroll", event.scrollTop, "container.user.away"),
          `scrollTop=${event.scrollTop} atBottom=false`,
        );
      }
      if (
        event.verticalDelta > atBottomThreshold &&
        state.mode === "reviewing" &&
        !state.touchActive
      ) {
        return finish(
          state,
          withFollowing(state, "none", event.scrollTop, "container.user.bottom-down"),
          `delta=${event.verticalDelta} threshold=${atBottomThreshold}`,
        );
      }
      return finish(
        state,
        {
          ...state,
          lastScrollTop: event.scrollTop,
          lastTransitionId: "container.user.bottom-small-delta",
        },
        `delta=${event.verticalDelta} threshold=${atBottomThreshold}`,
      );
    }
    case "touch-start": {
      return finish(
        state,
        {
          ...withReview(state, "touch", event.scrollTop, "touch.start"),
          touchActive: true,
          touchStartY: event.clientY,
          touchStartScrollTop: event.scrollTop,
          touchReviewNotified: false,
        },
        `clientY=${event.clientY ?? "null"}`,
      );
    }
    case "touch-move": {
      const movement =
        state.touchStartY === null || event.clientY === null
          ? 0
          : Math.abs(event.clientY - state.touchStartY);
      if (movement >= event.reviewThresholdPx && !state.touchReviewNotified) {
        return finish(
          state,
          {
            ...state,
            touchReviewNotified: true,
            lastTransitionId: "touch.move.review",
          },
          `movement=${movement} threshold=${event.reviewThresholdPx}`,
          true,
        );
      }
      return finish(
        state,
        { ...state, lastTransitionId: "touch.move.below-threshold" },
        `movement=${movement} threshold=${event.reviewThresholdPx}`,
      );
    }
    case "touch-end":
    case "touch-cancel":
      return finishTouchGesture(state, event, atBottomThreshold);
    default:
      return assertNever(event);
  }
}
