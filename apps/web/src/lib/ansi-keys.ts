// CONTEXT Addendum D-21：5 个预烤 ANSI 常量，覆盖语义功能面板的 PTY 通路
// 不实现完整 ANSI 映射表，物理键盘捕获已放弃，仅通过 semantic 按钮触发
import { wsManagerRef } from "@/hooks/use-relay-setup";

export const ANSI_INTERRUPT = "\x03";
export const ANSI_TAB = "\t";
export const ANSI_UP = "\x1b[A";
export const ANSI_DOWN = "\x1b[B";
export const ANSI_ESC = "\x1b";

export type SemanticAction =
  | "interrupt"
  | "toggle_permission"
  | "history_prev"
  | "history_next"
  | "cancel";

const ACTION_MAP: Record<SemanticAction, string> = {
  interrupt: ANSI_INTERRUPT,
  toggle_permission: ANSI_TAB,
  history_prev: ANSI_UP,
  history_next: ANSI_DOWN,
  cancel: ANSI_ESC,
};

export function ansiForAction(action: SemanticAction): string {
  return ACTION_MAP[action];
}

// 通过 wsManagerRef 发送 remote_input_raw 信封到 relay
// data 是已编码的 ANSI 字节字符串，sessionId 是目标 PTY session
export function sendRemoteInputRaw(sessionId: string, data: string): void {
  if (!sessionId || !data) return;
  const ws = wsManagerRef;
  if (!ws) return;
  ws.send(
    JSON.stringify({
      type: "remote_input_raw",
      sessionId,
      data,
    }),
  );
}

export function sendSemanticAction(sessionId: string, action: SemanticAction): void {
  sendRemoteInputRaw(sessionId, ansiForAction(action));
}
