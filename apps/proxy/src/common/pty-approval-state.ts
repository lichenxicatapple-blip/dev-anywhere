import type { PtySemanticState } from "./osc-extractor.js";

export function shouldReleaseApprovalWait(options: {
  currentState: PtySemanticState;
  signalState?: PtySemanticState;
}): boolean {
  if (options.currentState !== "approval_wait") return false;
  return options.signalState !== undefined && options.signalState !== "approval_wait";
}

export function stateAfterApprovalRelease(signalState?: PtySemanticState): PtySemanticState {
  return signalState && signalState !== "approval_wait" ? signalState : "working";
}
