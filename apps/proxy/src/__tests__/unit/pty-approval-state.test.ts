import { describe, expect, it } from "vitest";
import {
  shouldReleaseTextApprovalOnInput,
  shouldReleaseApprovalWait,
  stateAfterApprovalRelease,
} from "#src/common/pty-approval-state.js";

describe("PTY approval state transitions", () => {
  it("releases approval wait when the provider emits a new explicit semantic state", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: "working",
      }),
    ).toBe(true);
  });

  it("releases approval wait when only OSC 0 title changes (signalState=null, codex cancel)", () => {
    // codex 取消审批后只发 OSC 0 标题变化（脱离 "Action Required"），osc-extractor 归类为
    // signalState=null（title-only update）。在 approval_wait 上下文里这就是释放信号。
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: null,
      }),
    ).toBe(true);
  });

  it("keeps approval wait on title-only signals when title-only release is disabled", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: null,
        allowTitleOnlyRelease: false,
      }),
    ).toBe(false);
  });

  it("keeps approval wait when no signal is present (signalState=undefined)", () => {
    expect(
      shouldReleaseApprovalWait({
        currentState: "approval_wait",
        signalState: undefined,
      }),
    ).toBe(false);
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

  it("maps null signalState release to turn_complete (codex cancel-approval semantics)", () => {
    // codex 取消审批后 OSC 0 标题脱离 "Action Required", osc-extractor 给 state=null.
    // 释放语义 = turn_complete（等用户下一轮输入），与 claude OSC 9 释放路径对齐。
    expect(stateAfterApprovalRelease(null)).toBe("turn_complete");
  });

  it("maps working signalState release to working", () => {
    expect(stateAfterApprovalRelease("working")).toBe("working");
  });

  it("releases text-only approval when the user submits a decision", () => {
    expect(shouldReleaseTextApprovalOnInput("\r")).toBe(true);
    expect(shouldReleaseTextApprovalOnInput("1")).toBe(true);
    expect(shouldReleaseTextApprovalOnInput("2")).toBe(true);
    expect(shouldReleaseTextApprovalOnInput("\x1b")).toBe(true);
  });

  it("does not release text-only approval for navigation keys", () => {
    expect(shouldReleaseTextApprovalOnInput("\x1b[A")).toBe(false);
    expect(shouldReleaseTextApprovalOnInput("\t")).toBe(false);
  });
});
