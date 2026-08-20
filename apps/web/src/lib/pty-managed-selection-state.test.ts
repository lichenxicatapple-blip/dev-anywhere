import { describe, expect, it } from "vitest";
import {
  canPtyManagedSelectionAutoscroll,
  createInitialPtyManagedSelectionState,
  getPtyManagedSelectionRange,
  reducePtyManagedSelection,
  type PtyManagedSelectionState,
  type PtySelectionRange,
} from "./pty-managed-selection-state";

const originalRange: PtySelectionRange = {
  anchor: { row: 8, column: 3 },
  focus: { row: 10, column: 7 },
};

function press(state: PtyManagedSelectionState, pointerId = 4): PtyManagedSelectionState {
  return reducePtyManagedSelection(state, {
    type: "pointer-press",
    candidate: {
      pointerId,
      client: { x: 20, y: 30 },
      bufferPoint: { row: 8, column: 3 },
    },
  });
}

describe("PTY managed selection state", () => {
  it("requires real pointer movement before selection autoscroll can own the viewport", () => {
    let state = press(createInitialPtyManagedSelectionState());
    expect(state.phase).toBe("pressed");
    expect(canPtyManagedSelectionAutoscroll(state)).toBe(false);

    state = reducePtyManagedSelection(state, {
      type: "selection-autoscroll",
      pointerId: 4,
      bufferPoint: { row: 20, column: 5 },
    });
    state = reducePtyManagedSelection(state, {
      type: "pointer-move",
      pointerId: 4,
      client: { x: 20, y: 30 },
      bufferPoint: { row: 20, column: 5 },
    });
    expect(state.phase).toBe("pressed");

    state = reducePtyManagedSelection(state, {
      type: "pointer-move",
      pointerId: 4,
      client: { x: 21, y: 30 },
      bufferPoint: { row: 9, column: 4 },
    });
    expect(state.phase).toBe("selecting");
    expect(canPtyManagedSelectionAutoscroll(state)).toBe(true);

    state = reducePtyManagedSelection(state, {
      type: "selection-autoscroll",
      pointerId: 4,
      bufferPoint: { row: 20, column: 5 },
    });
    expect(getPtyManagedSelectionRange(state)).toEqual({
      anchor: { row: 8, column: 3 },
      focus: { row: 20, column: 5 },
    });
  });

  it("keeps a committed range fixed across wheel/scroll and restores it after cancellation", () => {
    let state = reducePtyManagedSelection(createInitialPtyManagedSelectionState(), {
      type: "set-selection",
      range: originalRange,
    });
    const selectedState = state;

    state = reducePtyManagedSelection(state, { type: "viewport-scroll", source: "wheel" });
    state = reducePtyManagedSelection(state, { type: "viewport-scroll", source: "scroll" });
    expect(state).toBe(selectedState);
    expect(getPtyManagedSelectionRange(state)).toEqual(originalRange);

    state = press(state);
    state = reducePtyManagedSelection(state, {
      type: "pointer-move",
      pointerId: 4,
      client: { x: 22, y: 30 },
      bufferPoint: { row: 30, column: 1 },
    });
    expect(getPtyManagedSelectionRange(state)?.anchor).toEqual({ row: 8, column: 3 });

    state = reducePtyManagedSelection(state, {
      type: "gesture-finish",
      pointerId: 4,
      result: "preserve-selection",
    });
    expect(state.phase).toBe("selected");
    expect(getPtyManagedSelectionRange(state)).toEqual(originalRange);
  });

  it("does not autoscroll a handle until that handle has actually moved", () => {
    let state = reducePtyManagedSelection(createInitialPtyManagedSelectionState(), {
      type: "set-selection",
      range: originalRange,
    });
    state = reducePtyManagedSelection(state, {
      type: "handle-drag-start",
      pointerId: 9,
      handle: "focus",
      client: { x: 100, y: 200 },
    });
    expect(canPtyManagedSelectionAutoscroll(state)).toBe(false);

    state = reducePtyManagedSelection(state, {
      type: "selection-autoscroll",
      pointerId: 9,
      bufferPoint: { row: 50, column: 2 },
    });
    expect(getPtyManagedSelectionRange(state)).toEqual(originalRange);

    state = reducePtyManagedSelection(state, {
      type: "pointer-move",
      pointerId: 9,
      client: { x: 101, y: 200 },
      bufferPoint: { row: 11, column: 8 },
    });
    expect(canPtyManagedSelectionAutoscroll(state)).toBe(true);
    expect(getPtyManagedSelectionRange(state)).toEqual({
      anchor: originalRange.anchor,
      focus: { row: 11, column: 8 },
    });
  });
});
