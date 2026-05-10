import type { PtySemanticState } from "./osc-extractor.js";

// signalState 三态：undefined 表示本帧没有任何 signal；null 表示有 signal 但只承载 title（OSC 0
// only，无明确语义）；其它值是明确语义状态。title-only signal 也视为对 approval_wait 的释放
// 信号——codex 取消审批后 OSC 0 标题脱离 "Action Required" 即走这条路径。
export function shouldReleaseApprovalWait(options: {
  currentState: PtySemanticState;
  signalState: PtySemanticState | null | undefined;
}): boolean {
  if (options.currentState !== "approval_wait") return false;
  if (options.signalState === undefined) return false;
  return options.signalState !== "approval_wait";
}

export function stateAfterApprovalRelease(
  signalState: PtySemanticState | null,
): PtySemanticState {
  // title-only 释放（signal.state===null）= codex 取消审批语义，等用户下一轮输入。
  if (signalState === null) return "turn_complete";
  return signalState !== "approval_wait" ? signalState : "working";
}
