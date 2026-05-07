import { describe, expect, it } from "vitest";
import {
  shouldReleaseApprovalWait,
  stateAfterApprovalRelease,
} from "#src/common/pty-approval-state.js";

describe("PTY approval state transitions", () => {
  it("releases approval wait when the approval screen is gone and Codex keeps spinning", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        approvalScreenState: null,
        signalState: "mid_pause",
      }),
    ).toBe(true);
    expect(stateAfterApprovalRelease("mid_pause")).toBe("mid_pause");
  });

  it("keeps approval wait while the native approval prompt is still visible", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        approvalScreenState: "waiting",
        signalState: "mid_pause",
      }),
    ).toBe(false);
  });

  it("does not convert turn completion into working", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        approvalScreenState: null,
        signalState: "turn_complete",
      }),
    ).toBe(false);
  });

  it("keeps approval wait for plain output without explicit resolution", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        approvalScreenState: null,
      }),
    ).toBe(false);
  });

  it("releases approval wait when the provider screen explicitly reports resolution", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        approvalScreenState: "resolved",
      }),
    ).toBe(true);
    expect(stateAfterApprovalRelease()).toBe("working");
  });
});
