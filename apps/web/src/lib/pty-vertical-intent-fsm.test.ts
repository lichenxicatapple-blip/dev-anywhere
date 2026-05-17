import { describe, expect, it } from "vitest";
import {
  PTY_VERTICAL_INTENT_TRANSITION_IDS,
  canPassiveFollow,
  createInitialPtyVerticalIntentState,
  isReviewing,
  reducePtyVerticalIntent,
  type PtyVerticalIntentEvent,
  type PtyVerticalIntentMode,
  type PtyVerticalIntentSource,
  type PtyVerticalIntentState,
} from "./pty-vertical-intent-fsm";

function reviewingState(overrides: Partial<PtyVerticalIntentState> = {}): PtyVerticalIntentState {
  return {
    ...createInitialPtyVerticalIntentState({ initialIntent: true, scrollTop: 100 }),
    ...overrides,
  };
}

function touchReviewingState(
  overrides: Partial<PtyVerticalIntentState> = {},
): PtyVerticalIntentState {
  return reviewingState({
    source: "touch",
    touchActive: true,
    touchStartY: 300,
    touchStartScrollTop: 100,
    lastTransitionId: "touch.start",
    ...overrides,
  });
}

describe("pty vertical intent FSM", () => {
  it("preserves restored review intent on attach even if geometry says bottom", () => {
    const state = createInitialPtyVerticalIntentState();
    const result = reducePtyVerticalIntent(state, {
      type: "attach",
      initialIntent: true,
      scrollTop: 0,
    });

    expect(result.state.mode).toBe("reviewing");
    expect(result.state.source).toBe("initial");
    expect(isReviewing(result.state)).toBe(true);
    expect(canPassiveFollow(result.state)).toBe(false);
  });

  it("does not clear review intent on wheel down until cursor-aware bottom is reached", () => {
    const reviewing = reducePtyVerticalIntent(createInitialPtyVerticalIntentState(), {
      type: "wheel",
      deltaY: -120,
      previousScrollTop: 1600,
      nextScrollTop: 1480,
      reachedCursorAwareBottom: false,
    }).state;

    const result = reducePtyVerticalIntent(reviewing, {
      type: "wheel",
      deltaY: 120,
      previousScrollTop: 1480,
      nextScrollTop: 1600,
      reachedCursorAwareBottom: false,
    });

    expect(result.state.mode).toBe("reviewing");
  });

  it("clears review intent on explicit forced scroll to bottom", () => {
    const reviewing = reducePtyVerticalIntent(createInitialPtyVerticalIntentState(), {
      type: "touch-start",
      clientY: 300,
      scrollTop: 100,
    }).state;

    const result = reducePtyVerticalIntent(reviewing, {
      type: "scroll-to-bottom",
      force: true,
      reason: "backToBottomBtn",
    });

    expect(result.state.mode).toBe("following");
    expect(result.outputPausedChanged).toBe(true);
  });

  it("clears transient touch review when a bottom touch ends without scrolling", () => {
    const touchingAtBottom = reducePtyVerticalIntent(createInitialPtyVerticalIntentState(), {
      type: "touch-start",
      clientY: 300,
      scrollTop: 1600,
    }).state;

    const result = reducePtyVerticalIntent(touchingAtBottom, {
      type: "touch-end",
      scrollTop: 1600,
      atCursorAwareBottom: true,
    });

    expect(result.state.mode).toBe("following");
    expect(result.trace?.action).toBe("clear");
  });

  it("clears touch review when viewport resize changes the raw bottom scrollTop", () => {
    const touchingAtBottom = reducePtyVerticalIntent(createInitialPtyVerticalIntentState(), {
      type: "touch-start",
      clientY: 300,
      scrollTop: 21035,
    }).state;

    const result = reducePtyVerticalIntent(touchingAtBottom, {
      type: "touch-end",
      scrollTop: 20686,
      atCursorAwareBottom: true,
      releaseOnSemanticBottom: true,
    });

    expect(result.state.mode).toBe("following");
    expect(result.trace?.id).toBe("touch.end.bottom-down");
    expect(result.trace?.action).toBe("clear");
  });

  const cases: Array<{
    id: (typeof PTY_VERTICAL_INTENT_TRANSITION_IDS)[number];
    initial: PtyVerticalIntentState;
    event: PtyVerticalIntentEvent;
    expectedMode: PtyVerticalIntentMode;
    expectedSource: PtyVerticalIntentSource;
    expectedTraceAction: "set" | "clear" | "keep";
    expectedNotifyTouchReviewStart?: boolean;
    expectedTouchActive?: boolean;
    expectedTouchReviewNotified?: boolean;
  }> = [
    {
      id: "attach.following",
      initial: createInitialPtyVerticalIntentState(),
      event: { type: "attach", initialIntent: false, scrollTop: 0 },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "keep",
    },
    {
      id: "attach.reviewing",
      initial: createInitialPtyVerticalIntentState(),
      event: { type: "attach", initialIntent: true, scrollTop: 0 },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "set",
    },
    {
      id: "bottom.passive.reviewing",
      initial: reviewingState(),
      event: { type: "scroll-to-bottom", force: false, reason: "rawInput" },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "keep",
    },
    {
      id: "bottom.passive.following",
      initial: createInitialPtyVerticalIntentState(),
      event: { type: "scroll-to-bottom", force: false, reason: "pendingFrame" },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "keep",
    },
    {
      id: "bottom.force",
      initial: reviewingState(),
      event: { type: "scroll-to-bottom", force: true, reason: "backToBottomBtn" },
      expectedMode: "following",
      expectedSource: "programmatic-bottom",
      expectedTraceAction: "clear",
    },
    {
      id: "ratio.reviewing",
      initial: createInitialPtyVerticalIntentState(),
      event: { type: "scroll-to-ratio", ratio: 0.5, scrollTop: 800 },
      expectedMode: "reviewing",
      expectedSource: "ratio-scroll",
      expectedTraceAction: "set",
    },
    {
      id: "wheel.clamped",
      initial: reviewingState(),
      event: {
        type: "wheel",
        deltaY: 120,
        previousScrollTop: 1600,
        nextScrollTop: 1600,
        reachedCursorAwareBottom: true,
      },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "keep",
    },
    {
      id: "wheel.up",
      initial: createInitialPtyVerticalIntentState(),
      event: {
        type: "wheel",
        deltaY: -120,
        previousScrollTop: 1600,
        nextScrollTop: 1480,
        reachedCursorAwareBottom: false,
      },
      expectedMode: "reviewing",
      expectedSource: "wheel",
      expectedTraceAction: "set",
    },
    {
      id: "wheel.down.not-bottom",
      initial: reviewingState({ source: "wheel" }),
      event: {
        type: "wheel",
        deltaY: 120,
        previousScrollTop: 1480,
        nextScrollTop: 1600,
        reachedCursorAwareBottom: false,
      },
      expectedMode: "reviewing",
      expectedSource: "wheel",
      expectedTraceAction: "keep",
    },
    {
      id: "wheel.down.bottom",
      initial: reviewingState({ source: "wheel" }),
      event: {
        type: "wheel",
        deltaY: 120,
        previousScrollTop: 1480,
        nextScrollTop: 1600,
        reachedCursorAwareBottom: true,
      },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "clear",
    },
    {
      id: "container.programmatic-follow",
      initial: reviewingState(),
      event: {
        type: "container-scroll",
        source: "programmatic-follow",
        scrollTop: 500,
        atCursorAwareBottom: false,
        verticalDelta: -100,
      },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "keep",
    },
    {
      id: "container.programmatic-bottom",
      initial: createInitialPtyVerticalIntentState(),
      event: {
        type: "container-scroll",
        source: "programmatic-bottom",
        scrollTop: 1600,
        atCursorAwareBottom: true,
        verticalDelta: 100,
      },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "keep",
    },
    {
      id: "container.external-sync",
      initial: reviewingState(),
      event: {
        type: "container-scroll",
        source: "external-sync",
        scrollTop: 400,
        atCursorAwareBottom: false,
        verticalDelta: -100,
      },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "keep",
    },
    {
      id: "container.user.away",
      initial: createInitialPtyVerticalIntentState(),
      event: {
        type: "container-scroll",
        source: "user",
        scrollTop: 300,
        atCursorAwareBottom: false,
        verticalDelta: -100,
      },
      expectedMode: "reviewing",
      expectedSource: "native-scroll",
      expectedTraceAction: "set",
    },
    {
      id: "container.user.bottom-small-delta",
      initial: reviewingState(),
      event: {
        type: "container-scroll",
        source: "user",
        scrollTop: 1601,
        atCursorAwareBottom: true,
        verticalDelta: 1,
      },
      expectedMode: "reviewing",
      expectedSource: "initial",
      expectedTraceAction: "keep",
    },
    {
      id: "container.user.bottom-down",
      initial: reviewingState(),
      event: {
        type: "container-scroll",
        source: "user",
        scrollTop: 1600,
        atCursorAwareBottom: true,
        verticalDelta: 120,
      },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "clear",
    },
    {
      id: "touch.start",
      initial: createInitialPtyVerticalIntentState(),
      event: { type: "touch-start", clientY: 300, scrollTop: 100 },
      expectedMode: "reviewing",
      expectedSource: "touch",
      expectedTraceAction: "set",
      expectedTouchActive: true,
      expectedTouchReviewNotified: false,
    },
    {
      id: "touch.move.below-threshold",
      initial: touchReviewingState(),
      event: { type: "touch-move", clientY: 295, reviewThresholdPx: 8 },
      expectedMode: "reviewing",
      expectedSource: "touch",
      expectedTraceAction: "keep",
      expectedNotifyTouchReviewStart: false,
      expectedTouchActive: true,
      expectedTouchReviewNotified: false,
    },
    {
      id: "touch.move.review",
      initial: touchReviewingState(),
      event: { type: "touch-move", clientY: 280, reviewThresholdPx: 8 },
      expectedMode: "reviewing",
      expectedSource: "touch",
      expectedTraceAction: "keep",
      expectedNotifyTouchReviewStart: true,
      expectedTouchActive: true,
      expectedTouchReviewNotified: true,
    },
    {
      id: "touch.end.not-bottom",
      initial: touchReviewingState(),
      event: { type: "touch-end", scrollTop: 90, atCursorAwareBottom: false },
      expectedMode: "reviewing",
      expectedSource: "touch",
      expectedTraceAction: "keep",
      expectedTouchActive: false,
      expectedTouchReviewNotified: false,
    },
    {
      id: "touch.end.bottom-down",
      initial: touchReviewingState(),
      event: { type: "touch-end", scrollTop: 1600, atCursorAwareBottom: true },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "clear",
      expectedTouchActive: false,
      expectedTouchReviewNotified: false,
    },
    {
      id: "touch.cancel.not-bottom",
      initial: touchReviewingState(),
      event: { type: "touch-cancel", scrollTop: 90, atCursorAwareBottom: false },
      expectedMode: "reviewing",
      expectedSource: "touch",
      expectedTraceAction: "keep",
      expectedTouchActive: false,
      expectedTouchReviewNotified: false,
    },
    {
      id: "touch.cancel.bottom-down",
      initial: touchReviewingState(),
      event: { type: "touch-cancel", scrollTop: 1600, atCursorAwareBottom: true },
      expectedMode: "following",
      expectedSource: "none",
      expectedTraceAction: "clear",
      expectedTouchActive: false,
      expectedTouchReviewNotified: false,
    },
  ];

  it("has one table case for every transition id", () => {
    expect(new Set(cases.map((c) => c.id))).toEqual(new Set(PTY_VERTICAL_INTENT_TRANSITION_IDS));
  });

  it.each(cases)("$id", (testCase) => {
    const result = reducePtyVerticalIntent(testCase.initial, testCase.event);

    expect(result.trace?.id).toBe(testCase.id);
    expect(result.trace?.action).toBe(testCase.expectedTraceAction);
    expect(result.state.lastTransitionId).toBe(testCase.id);
    expect(result.state.mode).toBe(testCase.expectedMode);
    expect(result.state.source).toBe(testCase.expectedSource);
    expect(result.notifyTouchReviewStart).toBe(testCase.expectedNotifyTouchReviewStart ?? false);
    if (testCase.expectedTouchActive !== undefined) {
      expect(result.state.touchActive).toBe(testCase.expectedTouchActive);
    }
    if (testCase.expectedTouchReviewNotified !== undefined) {
      expect(result.state.touchReviewNotified).toBe(testCase.expectedTouchReviewNotified);
    }
  });
});
