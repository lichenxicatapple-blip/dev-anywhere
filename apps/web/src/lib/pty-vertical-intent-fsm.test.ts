import { describe, expect, it } from "vitest";
import {
  canPassiveFollow,
  createInitialPtyVerticalIntentState,
  isReviewing,
  reducePtyVerticalIntent,
} from "./pty-vertical-intent-fsm";

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
});
