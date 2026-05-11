// PTY 局部语义状态。仅承载明确语义信号; title/spinner 变化时事件的 state 取 null,
// 让上层不参与 FSM 切换, 只走 title 推送通道。
// 单一 source of truth: osc-extractor / ipc-protocol / shared schema 都从这里取。
export const PtySemanticState = {
  WORKING: "working",
  TURN_COMPLETE: "turn_complete",
  APPROVAL_WAIT: "approval_wait",
} as const;

export type PtySemanticState = (typeof PtySemanticState)[keyof typeof PtySemanticState];

// zod / 类型字面量场景下复用的 const tuple, z.enum 直接吃。
export const ptySemanticStateValues = [
  PtySemanticState.WORKING,
  PtySemanticState.TURN_COMPLETE,
  PtySemanticState.APPROVAL_WAIT,
] as const;
