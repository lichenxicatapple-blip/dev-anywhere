import type { Socket } from "node:net";
import { serializeWorkerMsg } from "../ipc/ipc-protocol.js";
import { serviceLogger } from "../common/logger.js";

// 待审批的工具调用元数据，registered 时由 caller 提供
interface PendingApproval {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  workerSocket: Socket;
}

interface ApprovalResponse {
  behavior: "allow" | "deny";
  message?: string;
}

// 追踪 requestId → PendingApproval 的映射，负责把审批结果写回 worker。
// 三条清理路径：正常响应 take()、worker 断开 cleanupSession()、会话终止复用 cleanupSession()。
export class ToolApprovalManager {
  private pending = new Map<string, PendingApproval>();

  register(requestId: string, approval: PendingApproval): void {
    this.pending.set(requestId, approval);
  }

  // 取出并删除 pending entry。caller 拿到后调 respond() 把结果写回 worker。
  take(requestId: string): PendingApproval | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);
    return entry;
  }

  // 写审批响应到 worker socket；socket 不可写时静默，worker 早晚会感知自己退出。
  respond(approval: PendingApproval, requestId: string, response: ApprovalResponse): void {
    if (!approval.workerSocket.writable) return;
    approval.workerSocket.write(
      serializeWorkerMsg({
        type: "worker_approval_response",
        requestId,
        behavior: response.behavior,
        ...(response.message !== undefined ? { message: response.message } : {}),
      }),
    );
  }

  // worker 断开或会话终止时，统一 deny 该 session 的所有 pending 并清出 map。
  cleanupSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.respond(pending, requestId, { behavior: "deny", message: reason });
      this.pending.delete(requestId);
      serviceLogger.info({ sessionId, requestId, reason }, "Pending tool approval denied");
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
