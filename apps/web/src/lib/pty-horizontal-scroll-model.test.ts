import { describe, expect, it } from "vitest";
import {
  clearPtyHorizontalIntent,
  createInitialPtyHorizontalScrollState,
  markPtyHorizontalUserInput,
  reducePtyHorizontalContainerScroll,
  setPtyHorizontalPendingFollow,
} from "./pty-horizontal-scroll-model";

describe("pty horizontal scroll model", () => {
  it("marks recent explicit horizontal input as intent", () => {
    const marked = markPtyHorizontalUserInput(createInitialPtyHorizontalScrollState(), {
      now: 1000,
      details: "site=wheel",
    });

    expect(marked.state.intent).toBe(true);
    expect(marked.state.lastUserInputAt).toBe(1000);
    expect(marked.trace).toEqual({ kind: "set", details: "site=wheel" });
  });

  it("ignores the scroll event caused by programmatic follow", () => {
    const state = setPtyHorizontalPendingFollow(createInitialPtyHorizontalScrollState(), 120);

    expect(
      reducePtyHorizontalContainerScroll(state, {
        hasOverflow: true,
        scrollLeft: 120.5,
        now: 1000,
        nativeIntentThresholdPx: 24,
      }),
    ).toEqual({
      state: {
        ...state,
        pendingFollowLeft: null,
        unmarkedOriginLeft: null,
        lastSeenLeft: 120.5,
      },
      trace: null,
      resetScrollLeft: false,
    });
  });

  it("waits for native scroll drift to exceed the threshold before setting intent", () => {
    const first = reducePtyHorizontalContainerScroll(createInitialPtyHorizontalScrollState(), {
      hasOverflow: true,
      scrollLeft: 8,
      now: 1000,
      nativeIntentThresholdPx: 24,
    });

    expect(first.state.intent).toBe(false);
    expect(first.state.unmarkedOriginLeft).toBe(0);
    expect(first.trace?.kind).toBe("ignore");

    const second = reducePtyHorizontalContainerScroll(first.state, {
      hasOverflow: true,
      scrollLeft: 30,
      now: 1010,
      nativeIntentThresholdPx: 24,
    });

    expect(second.state.intent).toBe(true);
    expect(second.state.unmarkedOriginLeft).toBeNull();
    expect(second.trace).toEqual({
      kind: "set",
      details: "site=onContainerScroll-native prev=0 next=30 delta=30",
    });
  });

  it("clears intent and asks caller to reset scrollLeft when overflow disappears", () => {
    const marked = markPtyHorizontalUserInput(createInitialPtyHorizontalScrollState(), {
      now: 1000,
      details: "site=wheel",
    });
    const cleared = reducePtyHorizontalContainerScroll(marked.state, {
      hasOverflow: false,
      scrollLeft: 12,
      now: 1100,
      nativeIntentThresholdPx: 24,
    });

    expect(cleared.resetScrollLeft).toBe(true);
    expect(cleared.state.intent).toBe(false);
    expect(cleared.trace?.kind).toBe("clear");
  });

  it("clears explicit intent without changing last seen scroll when requested", () => {
    const marked = markPtyHorizontalUserInput(createInitialPtyHorizontalScrollState(), {
      now: 1000,
      details: "site=wheel",
    });

    expect(
      clearPtyHorizontalIntent(marked.state, {
        details: "site=reset",
      }).state.intent,
    ).toBe(false);
  });
});
