// Chat 模式消息 dispatcher.
// 订阅 relayClient.onMessage, 按 MessageEnvelopeSchema / RelayControlSchema 的真实 type literal 分发.
// proxy 已完成 stream-json 解析, 客户端只接收类型化 envelope (assistant_message.text 就是助手说的话)
// 真实 type literals (见 packages/shared/src/schemas/envelope.ts + relay-control.ts):
//   Envelope 层: assistant_message / tool_use_request / tool_result / thinking / user_input
//   Control 层: pending_approvals_push / session_history_messages / turn_result
import type { MessageEnvelope, RelayControlMessage } from "@dev-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import type { RelayClient } from "@/services/relay-client";

type InboundMessage = MessageEnvelope | RelayControlMessage;
type ChatRelay = Pick<RelayClient, "sendControl">;

function handleAssistantMessage(env: Extract<MessageEnvelope, { type: "assistant_message" }>) {
  const store = useChatStore.getState();
  if (env.payload.text.length > 0) {
    store.appendAssistantText(env.sessionId, env.payload.text);
  }
  // isPartial=false 仅在 proxy 兜底场景 (如历史聚合纯文本) 出现；session.state 由 proxy session_status 推送维护
  if (!env.payload.isPartial) {
    store.markTurnComplete(env.sessionId);
  }
}

function handleToolUseRequest(
  env: Extract<MessageEnvelope, { type: "tool_use_request" }>,
  relay: Pick<RelayClient, "sendControl"> | null,
) {
  const store = useChatStore.getState();
  // 审批 ID = toolId (ToolUseRequestPayloadSchema)
  store.addApprovalRequest(env.sessionId, {
    requestId: env.payload.toolId,
    toolName: env.payload.toolName,
    input: env.payload.parameters,
    status: "pending",
  });
  relay?.sendControl({
    type: "permission_request_delivered",
    sessionId: env.sessionId,
    requestId: env.payload.toolId,
  });
}

function handleToolResult(env: Extract<MessageEnvelope, { type: "tool_result" }>) {
  // 工具结果到达 => 对应 approval 已执行完成, 标记为 approved (被拒绝的不会有 tool_result)
  const store = useChatStore.getState();
  store.updateApprovalStatus(env.sessionId, env.payload.toolId, "approved");
}

function handleAssistantToolUse(env: Extract<MessageEnvelope, { type: "assistant_tool_use" }>) {
  // 非审批型工具调用只承载“正在用哪个工具”的语义。审批型工具仍走 tool_use_request。
  useChatStore.getState().setWorkingTool(env.sessionId, env.payload.toolName);
}

function handlePendingApprovalsPush(
  msg: Extract<RelayControlMessage, { type: "pending_approvals_push" }>,
  relay: Pick<RelayClient, "sendControl"> | null,
) {
  // 重连后 relay 推送 proxy 当前 pending 审批全量, 增量补齐未知项, 不重复入队已有项
  const store = useChatStore.getState();
  const existing = store.bySessionId[msg.sessionId]?.pendingApprovals ?? [];
  const existingIds = new Set(existing.map((a) => a.requestId));
  for (const appr of msg.approvals) {
    if (existingIds.has(appr.requestId)) continue;
    store.addApprovalRequest(msg.sessionId, {
      requestId: appr.requestId,
      toolName: appr.toolName,
      input: appr.input,
      status: "pending",
    });
    relay?.sendControl({
      type: "permission_request_delivered",
      sessionId: msg.sessionId,
      requestId: appr.requestId,
    });
  }
}

function handlePermissionDecisionResult(
  msg: Extract<RelayControlMessage, { type: "permission_decision_result" }>,
) {
  if (!msg.delivered) return;
  useChatStore
    .getState()
    .updateApprovalStatus(
      msg.sessionId,
      msg.requestId,
      msg.outcome === "allow" ? "approved" : "denied",
    );
}

function handleSessionHistoryMessages(
  msg: Extract<RelayControlMessage, { type: "session_history_messages" }>,
) {
  const store = useChatStore.getState();
  store.loadHistory(msg.sessionId, msg.messages);
}

function handleTurnResult(msg: Extract<RelayControlMessage, { type: "turn_result" }>) {
  const store = useChatStore.getState();
  const resultText = typeof msg.result === "string" ? msg.result : "";
  if (resultText.trim()) {
    const slice = store.bySessionId[msg.sessionId];
    const last = slice?.messages[slice.messages.length - 1];
    const lastAssistantHasText =
      last?.role === "assistant" && last.text.trim().length > 0 && last.isPartial;
    if (!lastAssistantHasText) {
      store.appendAssistantText(msg.sessionId, resultText);
    }
  }
  store.markTurnComplete(msg.sessionId);
}

function handleTerminalTitle(msg: Extract<RelayControlMessage, { type: "terminal_title" }>) {
  // proxy 抽 OSC 0 后推送, chat-header 为 PTY 模式优先用这个值
  useSessionStore.getState().setPtyTitle(msg.sessionId, msg.title);
}

export function registerChatDispatcher(): () => void {
  const relay = relayClientRef;
  if (!relay) {
    console.warn("registerChatDispatcher called before relayClient bound; skipping");
    return () => {};
  }

  return relay.onMessage(createChatMessageHandler(relay));
}

export function createChatMessageHandler(relay: ChatRelay | null): (msg: InboundMessage) => void {
  return (msg: InboundMessage) => {
    switch (msg.type) {
      case "assistant_message":
        handleAssistantMessage(msg);
        break;
      case "tool_use_request":
        handleToolUseRequest(msg, relay);
        break;
      case "tool_result":
        handleToolResult(msg);
        break;
      case "assistant_tool_use":
        handleAssistantToolUse(msg);
        break;
      case "thinking":
        // thinking 文本不进入聊天流；UI 只通过 agent_status/session_status 展示响应状态。
        break;
      case "user_input":
        // Echo: 本端已乐观入 store, 此处不重复追加
        break;
      case "pending_approvals_push":
        handlePendingApprovalsPush(msg, relay);
        break;
      case "permission_decision_result":
        handlePermissionDecisionResult(msg);
        break;
      case "session_history_messages":
        if (msg.requestId) break;
        handleSessionHistoryMessages(msg);
        break;
      case "turn_result":
        handleTurnResult(msg);
        break;
      case "terminal_title":
        handleTerminalTitle(msg);
        break;
      default:
        break;
    }
  };
}
