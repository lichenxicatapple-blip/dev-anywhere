import type { PtySemanticState } from "./osc-extractor.js";

export function shouldReleaseApprovalWait(options: {
  currentState: PtySemanticState;
  screenShowsApproval: boolean;
  signalState?: PtySemanticState;
}): boolean {
  if (options.currentState !== "approval_wait") return false;
  if (options.screenShowsApproval) return false;
  return options.signalState !== "approval_wait" && options.signalState !== "turn_complete";
}

export function stateAfterApprovalRelease(signalState?: PtySemanticState): PtySemanticState {
  return signalState && signalState !== "approval_wait" && signalState !== "turn_complete"
    ? signalState
    : "working";
}
