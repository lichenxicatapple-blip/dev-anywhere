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

// Web 创建 PTY 时可以按可用视口放大初始几何，但不能低于传统 80x24。
// 这个底线既保证常见 TUI 布局，也避免 Claude Code / Codex 等 CLI 因终端过窄
// 省略二维码或启动信息。上限用于拦截异常客户端提交的不合理 PTY 尺寸。
export const PTY_INITIAL_MIN_COLS = 80;
export const PTY_INITIAL_MIN_ROWS = 24;
export const PTY_INITIAL_MAX_COLS = 500;
export const PTY_INITIAL_MAX_ROWS = 200;
