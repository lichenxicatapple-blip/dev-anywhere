import { SessionState, type PtySemanticState } from "@dev-anywhere/shared";
import { shouldPromotePtyActivityToWorking } from "./pty-state-guard.js";
import { resolvePtySemanticSessionTransitions } from "./pty-semantic-lifecycle.js";
import type { SessionInfo } from "./session-manager.js";

// 把 PTY 语义状态投影到 Session FSM 转换 + 关联副作用。
//
// 本地终端与托管 worker 的语义事件均经 terminal-ipc 到达这里。
//
// PTY runtime 推断字节流的语义；这里负责会话状态及审批、通知等副作用。

export interface PtySessionBridgeDeps {
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  getSession: (sessionId: string) => SessionInfo | undefined;
  getPendingApprovalCount: (sessionId: string) => number;
  resolveInterruptedApprovals: (sessionId: string) => void;
  emitAgentStatus: (sessionId: string, phase: "idle") => void;
}

export function applyPtyStateToSession(
  deps: PtySessionBridgeDeps,
  sessionId: string,
  ptyState: PtySemanticState,
): void {
  // 单点拒绝非法源 state: session 不在 map 里 (已 terminate 删除) 或 state===TERMINATED 时,
  // 跳过所有 bridge 副作用——changeSessionState 会被 FSM 各自拒绝, 但 resolveInterruptedApprovals /
  // emitAgentStatus 等下游回调没有自己的 guard, 否则会对 zombie session 触发空跑或冗余事件。
  // 这一层把 "session 处于非法源状态" 的判定收口到此, 不依赖每个回调自己重新检查。
  const session = deps.getSession(sessionId);
  if (!session || session.state === SessionState.TERMINATED) return;

  switch (ptyState) {
    case "approval_wait":
      deps.changeSessionState(sessionId, SessionState.WAITING_APPROVAL);
      break;
    case "working": {
      if (session.state !== SessionState.IDLE && session.state !== SessionState.WAITING_APPROVAL) {
        break;
      }
      const pending = deps.getPendingApprovalCount(sessionId);
      if (shouldPromotePtyActivityToWorking(session, pending)) {
        deps.changeSessionState(sessionId, SessionState.WORKING);
      }
      break;
    }
    case "turn_complete": {
      deps.resolveInterruptedApprovals(sessionId);
      const transitions = resolvePtySemanticSessionTransitions(session.state, ptyState);
      for (const next of transitions) {
        deps.changeSessionState(sessionId, next);
      }
      deps.emitAgentStatus(sessionId, "idle");
      break;
    }
  }
}
