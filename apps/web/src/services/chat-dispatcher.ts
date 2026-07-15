// Chat 模式消息 dispatcher.
// 订阅 relayClient.onMessage, 按 MessageEnvelopeSchema / RelayControlSchema 的真实 type literal 分发.
// proxy 已完成 stream-json 解析, 客户端只接收类型化 envelope (assistant_message.text 就是助手说的话)
// 真实 type literals (见 packages/shared/src/schemas/envelope.ts + relay-control.ts):
//   Envelope 层: assistant_message / tool_use_request / tool_result / thinking / user_input
//   Control 层: pending_approvals_push / session_history_messages / turn_result
import type { MessageEnvelope, RelayControlMessage } from "@dev-anywhere/shared";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import type { RelayClient } from "@/services/relay-client";
import {
  getClaudeToolActivityDetails,
  summarizeClaudeToolActivity,
} from "@/lib/claude-activity-summary";
import { showCompactEndToast } from "@/lib/compact-toast";
import { toast } from "@/components/toast";
import { registerDispatcher } from "./dispatcher-registry";

type InboundMessage = MessageEnvelope | RelayControlMessage;
type ChatRelay = Pick<RelayClient, "sendControl"> & Partial<Pick<RelayClient, "sendEnvelope">>;

function queuedUserMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" && m.deliveryStatus === "queued");
}

function flushQueuedUserInputBatch(sessionId: string, relay: ChatRelay | null): boolean {
  if (!relay?.sendEnvelope) return false;
  const store = useChatStore.getState();
  const slice = store.bySessionId[sessionId];
  if (!slice) return false;
  if (slice.pendingApprovals.some((approval) => approval.status === "pending")) return false;
  const queued = queuedUserMessages(slice.messages);
  if (queued.length === 0) return false;
  const text = queued
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return false;

  const now = Date.now();
  for (const queuedMessage of queued) {
    const sentMessage = { ...queuedMessage };
    delete sentMessage.deliveryStatus;
    store.upsertUserMessage(sessionId, sentMessage);
  }
  useSessionStore.getState().updateSessionState(sessionId, "working", now);
  relay.sendEnvelope({
    type: "user_input",
    sessionId,
    payload: { text, messageId: queued[0].id },
    seq: 0,
    timestamp: now,
    source: "client",
    version: "1",
  });
  return true;
}

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

function handleUserInput(env: Extract<MessageEnvelope, { type: "user_input" }>) {
  const timestamp = Number.isFinite(env.timestamp) ? env.timestamp : Date.now();
  const messageId = env.payload.messageId ?? `${env.sessionId}-user-${timestamp}`;
  useChatStore.getState().addUserMessage(env.sessionId, {
    id: messageId,
    role: "user",
    text: env.payload.text,
    isPartial: false,
    timestamp,
    toolCalls: [],
  });
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
  store.completeActivityMessage(
    env.sessionId,
    env.payload.toolId,
    env.payload.isError ? "error" : "done",
  );
}

function handleAssistantToolUse(env: Extract<MessageEnvelope, { type: "assistant_tool_use" }>) {
  // 非审批型工具调用只承载“正在用哪个工具”的语义。审批型工具仍走 tool_use_request。
  const store = useChatStore.getState();
  store.setWorkingTool(env.sessionId, env.payload.toolName);
  store.upsertActivityMessage(env.sessionId, {
    id: env.payload.toolId,
    source: "claude-native",
    kind: "tool",
    status: "running",
    toolName: env.payload.toolName,
    text: summarizeClaudeToolActivity(env.payload.toolName, env.payload.parameters),
    details: getClaudeToolActivityDetails(env.payload.toolName, env.payload.parameters),
    durable: false,
  });
}

function handlePendingApprovalsPush(
  msg: Extract<RelayControlMessage, { type: "pending_approvals_push" }>,
  relay: Pick<RelayClient, "sendControl"> | null,
) {
  const store = useChatStore.getState();
  const approvals = msg.approvals.map((appr) => ({
    requestId: appr.requestId,
    toolName: appr.toolName,
    input: appr.input,
    status: "pending" as const,
  }));
  store.replacePendingApprovals(msg.sessionId, approvals);
  for (const appr of approvals) {
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
  const store = useChatStore.getState();
  if (!msg.delivered) {
    const approvals = store.bySessionId[msg.sessionId]?.pendingApprovals ?? [];
    store.replacePendingApprovals(
      msg.sessionId,
      approvals.filter((approval) => approval.requestId !== msg.requestId),
    );
    toast.error("审批请求已失效，已刷新状态");
    return;
  }
  store.updateApprovalStatus(
    msg.sessionId,
    msg.requestId,
    msg.outcome === "allow" ? "approved" : "denied",
  );
}

function handleSessionHistoryMessages(
  msg: Extract<RelayControlMessage, { type: "session_history_messages" }>,
) {
  const store = useChatStore.getState();
  store.loadHistoryPage(msg.sessionId, {
    mode: msg.before ? "prepend" : "replace",
    messages: msg.messages,
    hasMore: msg.hasMore,
    nextBefore: msg.nextBefore,
  });
}

function handleTurnResult(
  msg: Extract<RelayControlMessage, { type: "turn_result" }>,
  relay: ChatRelay | null,
) {
  const store = useChatStore.getState();
  const wasCompacting =
    useSessionStore.getState().sessions.find((session) => session.sessionId === msg.sessionId)
      ?.state === "compacting";
  const resultText = typeof msg.result === "string" ? msg.result : "";
  if (wasCompacting) {
    showCompactEndToast(msg.sessionId, msg.success && !msg.isError, resultText);
  }
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
  flushQueuedUserInputBatch(msg.sessionId, relay);
}

function handleTerminalTitle(msg: Extract<RelayControlMessage, { type: "terminal_title" }>) {
  // proxy 抽 OSC 0 后推送, chat-header 为 PTY 模式优先用这个值
  useSessionStore.getState().setPtyTitle(msg.sessionId, msg.title);
}

export function registerChatDispatcher(): () => void {
  return registerDispatcher("registerChatDispatcher", (relay) => createChatMessageHandler(relay));
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
        handleUserInput(msg);
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
        handleTurnResult(msg, relay);
        break;
      case "terminal_title":
        handleTerminalTitle(msg);
        break;
      default:
        break;
    }
  };
}
