import type { PtySemanticState } from "./osc-extractor.js";
import type { PtyApprovalScreenState } from "./pty-approval-screen.js";

export function shouldReleaseApprovalWait(options: {
  currentState: PtySemanticState;
  approvalScreenState: PtyApprovalScreenState | null;
  signalState?: PtySemanticState;
}): boolean {
  if (options.currentState !== "approval_wait") return false;
  if (options.approvalScreenState === "waiting") return false;
  if (options.approvalScreenState === "resolved") return true;
  return (
    options.signalState !== undefined &&
    options.signalState !== "approval_wait" &&
    options.signalState !== "turn_complete"
  );
}

export function stateAfterApprovalRelease(signalState?: PtySemanticState): PtySemanticState {
  return signalState && signalState !== "approval_wait" && signalState !== "turn_complete"
    ? signalState
    : "working";
}
