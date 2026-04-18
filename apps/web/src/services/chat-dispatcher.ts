// Chat 模式消息 dispatcher.
// 订阅 relayClient.onMessage, 按 MessageEnvelopeSchema / RelayControlSchema 的真实 type literal 分发.
// 真实 type literals (已对 packages/shared/src/schemas/* 核实):
//   Envelope 层 (packages/shared/src/schemas/envelope.ts L39-L129):
//     - "assistant_message"   payload: AssistantMessagePayloadSchema { text, isPartial }
//     - "tool_use_request"    payload: ToolUseRequestPayloadSchema { toolName, toolId, parameters }
//     - "tool_result"         payload: ToolResultPayloadSchema { toolId, result, isError }
//     - "thinking"            忽略, 不入 chat-store messages 数组
//     - "user_input"          忽略 echo (本端发送时已乐观入 store, 见 Plan 10-04b)
//   Control 层 (packages/shared/src/schemas/relay-control.ts L192-L212):
//     - "pending_approvals_push"    reconcile pending set
//     - "session_history_messages"  hydrate 历史
// 注意旧 plan 草稿曾提到若干虚构的 envelope type (例如 delta/complete 分裂版、单独的请求/批准/拒绝 event),
// 这些在 shared schema 中并不存在, 使用它们会让 zod safeParse 静默 drop. 本 dispatcher 严格只消费上列 7 种 literal.
import type { MessageEnvelope, RelayControlMessage } from "@cc-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useChatStore } from "@/stores/chat-store";

type InboundMessage = MessageEnvelope | RelayControlMessage;

function handleAssistantMessage(
  env: Extract<MessageEnvelope, { type: "assistant_message" }>,
) {
  const store = useChatStore.getState();
  // payload.isPartial=true => streaming chunk; false => turn done
  if (env.payload.isPartial) {
    store.appendAssistantText(env.payload.text);
    store.setWorking(true);
  } else {
    if (env.payload.text.length > 0) {
      store.appendAssistantText(env.payload.text);
    }
    store.markTurnComplete();
  }
}

function handleToolUseRequest(
  env: Extract<MessageEnvelope, { type: "tool_use_request" }>,
) {
  const store = useChatStore.getState();
  store.addApprovalRequest({
    // 审批 ID = toolId (ToolUseRequestPayloadSchema)
    requestId: env.payload.toolId,
    toolName: env.payload.toolName,
    input: env.payload.parameters,
    status: "pending",
  });
  store.setWorking(true);
}

function handleToolResult(
  env: Extract<MessageEnvelope, { type: "tool_result" }>,
) {
  // 工具结果到达 => 对应 approval 已执行完成, 标记为 approved (被拒绝的不会有 tool_result)
  const store = useChatStore.getState();
  store.updateApprovalStatus(env.payload.toolId, "approved");
  // NOTE: 详细的 tool call 输出流转 (追加 toolCall 到 message / 展示结果 JSON)
  // 由 Plan 10-04b ChatHeader + tool result rendering 进一步扩展, 本 Plan 仅维持 pending 生命周期.
}

function handlePendingApprovalsPush(
  msg: Extract<RelayControlMessage, { type: "pending_approvals_push" }>,
) {
  const store = useChatStore.getState();
  // 重连后 relay 推送 proxy 当前 pending 审批全量, 增量补齐未知项, 不重复入队已有项
  const existingIds = new Set(store.pendingApprovals.map((a) => a.requestId));
  for (const appr of msg.approvals) {
    if (existingIds.has(appr.requestId)) continue;
    store.addApprovalRequest({
      requestId: appr.requestId,
      toolName: appr.toolName,
      input: appr.input,
      status: "pending",
    });
  }
}

function handleSessionHistoryMessages(
  msg: Extract<RelayControlMessage, { type: "session_history_messages" }>,
) {
  const store = useChatStore.getState();
  // loadHistory 是 chat-store 现有 API, 接受 {role, text, timestamp?} 数组
  store.loadHistory(msg.messages);
}

export function registerChatDispatcher(): () => void {
  const relay = relayClientRef;
  if (!relay) {
    console.warn(
      "registerChatDispatcher called before relayClient bound; skipping",
    );
    return () => {};
  }

  return relay.onMessage((msg: InboundMessage) => {
    switch (msg.type) {
      // MessageEnvelope chat 类
      case "assistant_message":
        handleAssistantMessage(msg);
        break;
      case "tool_use_request":
        handleToolUseRequest(msg);
        break;
      case "tool_result":
        handleToolResult(msg);
        break;
      case "thinking":
        // 不入消息列表; Plan 10-04b 可暴露给 StatusLine
        break;
      case "user_input":
        // Echo: 本端已乐观入 store (10-04b), 此处不重复追加
        break;

      // RelayControlMessage chat 类
      case "pending_approvals_push":
        handlePendingApprovalsPush(msg);
        break;
      case "session_history_messages":
        handleSessionHistoryMessages(msg);
        break;

      // 其他 type 由 phase-machine 或后续 Plan 的 dispatcher 处理, 这里忽略
      default:
        break;
    }
  });
}
