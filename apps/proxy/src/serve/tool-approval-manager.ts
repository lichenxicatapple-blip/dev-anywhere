import { serviceLogger } from "../common/logger.js";

// 待审批的工具调用元数据。
// WorkerRegistry.forwardApprovalRequest() 在收到 worker_approval_request 时 register；
// RelayRouter.onToolApprove/onToolDeny 在收到 relay 指令后 take + 通过 WorkerRegistry.send 回写响应。
interface PendingApproval {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
}

// 纯数据管理器：记录 requestId → PendingApproval 的映射，清理路径不做 IO。
// 写 worker socket 的职责在 WorkerRegistry.send()，这里只负责谁在等。
export class ToolApprovalManager {
  private pending = new Map<string, PendingApproval>();

  register(requestId: string, approval: PendingApproval): void {
    this.pending.set(requestId, approval);
  }

  // 取出并删除 pending entry；caller 拿 sessionId 后自己调 WorkerRegistry.send 回写。
  take(requestId: string): PendingApproval | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);
    return entry;
  }

  // worker 断开或 session 终止时清掉该 session 的 pending。
  // 不再回写 deny response：worker 已断或 session 已终止，写了也没人读。
  cleanupSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      serviceLogger.info({ sessionId, requestId, reason }, "Pending tool approval dropped");
    }
  }

  // 用于 session_messages_request 重连后恢复审批卡片
  listSession(sessionId: string): Array<{
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
  }> {
    const out: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        out.push({ requestId, toolName: pending.toolName, input: pending.input });
      }
    }
    return out;
  }
}
