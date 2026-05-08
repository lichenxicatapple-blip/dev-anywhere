import { describe, expect, it } from "vitest";
import {
  shouldReleaseApprovalWait,
  stateAfterApprovalRelease,
} from "#src/common/pty-approval-state.js";

describe("PTY approval state transitions", () => {
  it("releases approval wait when the provider emits a new explicit semantic state", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: "mid_pause",
      }),
    ).toBe(true);
    expect(stateAfterApprovalRelease("mid_pause")).toBe("mid_pause");
  });

  it("keeps approval wait while the provider still reports approval wait", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: "approval_wait",
      }),
    ).toBe(false);
  });

  it("releases approval wait when the provider directly ends the turn", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: "turn_complete",
      }),
    ).toBe(true);
    expect(stateAfterApprovalRelease("turn_complete")).toBe("turn_complete");
  });

  it("keeps approval wait for plain output without explicit resolution", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
      }),
    ).toBe(false);
  });
});
