import { SessionState, type PtySemanticState } from "@dev-anywhere/shared";
import { shouldPromotePtyActivityToWorking } from "./pty-state-guard.js";
import { resolvePtySemanticSessionTransitions } from "./pty-semantic-lifecycle.js";
import type { SessionInfo } from "./session-manager.js";

// 把 PTY 语义状态投影到 Session FSM 转换 + 关联副作用。
//
// hosted-pty-registry（hosted PTY 模式，serve 进程内直接持有 PTY）和 terminal-ipc（local PTY
// 模式，worker 进程经 IPC 通知 serve）以前各写一份 PTY → Session 翻译，行为不一致：hosted 缺
// shouldPromotePtyActivityToWorking guard、turn_complete 直调 changeSessionState(IDLE) 而非
// 走 resolvePtySemanticSessionTransitions helper。这里收一份，两侧共用。
//
// 与 decidePtySemanticTransition 的关系：那是 PTY 推断层（字节流→PTY semantic），输入是 OSC
// 信号 + 局部状态，输出 PTY semantic transition；本函数是翻译层（PTY semantic→SessionState），
// 输入是 PTY 决策结果，输出是 SessionState 转换 + 关联副作用（清理 interrupted approvals、推
// agent status idle 等）。两层职责正交。

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
  switch (ptyState) {
    case "approval_wait":
      deps.changeSessionState(sessionId, SessionState.WAITING_APPROVAL);
      break;
    case "working": {
      const session = deps.getSession(sessionId);
      const pending = deps.getPendingApprovalCount(sessionId);
      if (shouldPromotePtyActivityToWorking(session, pending)) {
        deps.changeSessionState(sessionId, SessionState.WORKING);
      }
      break;
    }
    case "turn_complete": {
      deps.resolveInterruptedApprovals(sessionId);
      const session = deps.getSession(sessionId);
      const transitions = resolvePtySemanticSessionTransitions(session?.state, ptyState);
      for (const next of transitions) {
        deps.changeSessionState(sessionId, next);
      }
      deps.emitAgentStatus(sessionId, "idle");
      break;
    }
  }
}
