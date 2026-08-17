import { describe, expect, it } from "vitest";
import {
  beginPtyTouchScroll,
  createInitialPtyTouchScrollState,
  ensurePtyTouchPendingMode,
  lockPtyTouchVerticalGesture,
  markPtyTouchHorizontalGesture,
  markPtyTouchGesture,
  resetPtyTouchScrollSession,
  setPtyTouchGestureMode,
  updatePtyTouchMove,
} from "./pty-touch-scroll-state";

describe("pty touch scroll state", () => {
  it("starts a pending touch session with the captured anchor and coordinates", () => {
    const state = beginPtyTouchScroll(createInitialPtyTouchScrollState(), {
      startedAtCursorAwareBottom: true,
      startedReviewing: true,
      startClientX: 24,
      startClientY: 120,
      startScrollLeft: 8,
      now: 1000,
    });

    expect(state).toEqual({
      startedAtCursorAwareBottom: true,
      startedReviewing: true,
      startClientX: 24,
      startScrollLeft: 8,
      lastClientY: 120,
      lastGestureAt: 1000,
      lastHorizontalGestureAt: null,
      gestureMode: "pending",
      verticalDirection: null,
      reviewEndResumeEligible: false,
    });
  });

  it("keeps gesture mode unset when touchstart has no usable Y coordinate", () => {
    expect(
      beginPtyTouchScroll(createInitialPtyTouchScrollState(), {
        startedAtCursorAwareBottom: false,
        startedReviewing: false,
        startClientX: null,
        startClientY: null,
        startScrollLeft: 0,
        now: 1000,
      }).gestureMode,
    ).toBeNull();
  });

  it("updates move timestamp and lazily enters pending mode for active touches", () => {
    let state = createInitialPtyTouchScrollState();
    state = updatePtyTouchMove(state, { currentY: 220, now: 1100 });
    state = ensurePtyTouchPendingMode(state, { touchActive: true, currentY: 220 });

    expect(state.lastClientY).toBe(220);
    expect(state.lastGestureAt).toBe(1100);
    expect(state.gestureMode).toBe("pending");
  });

  it("sets mode, marks gesture time, and resets transient session fields", () => {
    let state = beginPtyTouchScroll(createInitialPtyTouchScrollState(), {
      startedAtCursorAwareBottom: true,
      startedReviewing: false,
      startClientX: 24,
      startClientY: 120,
      startScrollLeft: 8,
      now: 1000,
    });

    state = setPtyTouchGestureMode(state, "horizontal");
    state = markPtyTouchHorizontalGesture(state, 1400);
    state = markPtyTouchGesture(state, 1500);
    state = resetPtyTouchScrollSession(state);

    expect(state).toEqual({
      startedAtCursorAwareBottom: false,
      startedReviewing: false,
      startClientX: null,
      startScrollLeft: null,
      lastClientY: null,
      lastGestureAt: 1500,
      lastHorizontalGestureAt: 1400,
      gestureMode: null,
      verticalDirection: null,
      reviewEndResumeEligible: false,
    });
  });

  it("keeps toward-live review ownership through the native inertia window", () => {
    let state = beginPtyTouchScroll(createInitialPtyTouchScrollState(), {
      startedAtCursorAwareBottom: false,
      startedReviewing: true,
      startClientX: 24,
      startClientY: 120,
      startScrollLeft: 0,
      now: 1000,
    });

    state = lockPtyTouchVerticalGesture(state, "toward-live");
    expect(state.reviewEndResumeEligible).toBe(true);
    expect(state.verticalDirection).toBe("toward-live");

    state = resetPtyTouchScrollSession(state);
    expect(state.gestureMode).toBeNull();
    expect(state.reviewEndResumeEligible).toBe(true);

    state = beginPtyTouchScroll(state, {
      startedAtCursorAwareBottom: false,
      startedReviewing: true,
      startClientX: 24,
      startClientY: 120,
      startScrollLeft: 0,
      now: 1600,
    });
    state = lockPtyTouchVerticalGesture(state, "toward-history");
    expect(state.reviewEndResumeEligible).toBe(false);
    expect(state.verticalDirection).toBe("toward-history");
  });
});
