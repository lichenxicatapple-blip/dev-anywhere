// Session 生命周期消息 dispatcher (与 chat-dispatcher 分工: 本 dispatcher 只负责会话元数据, 不碰消息/审批).
// 订阅以下消息类型, 写入 session-store:
//   Envelope: session_list / session_status
//   Control:  agent_status / pty_state / session_history_response
// 未选 proxy 时短路, 避免跨 proxy 残留. 去重: chat-dispatcher 不消费这些类型, 无 race.
import type { MessageEnvelope, RelayControlMessage } from "@dev-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

type InboundMessage = MessageEnvelope | RelayControlMessage;

function handleSessionList(env: Extract<MessageEnvelope, { type: "session_list" }>): void {
  if (!useAppStore.getState().selectedProxyId) return;
  useSessionStore.getState().setSessions(env.payload.sessions);
}

function handleSessionStatus(env: Extract<MessageEnvelope, { type: "session_status" }>): void {
  useSessionStore
    .getState()
    .updateSessionState(env.payload.sessionId, env.payload.state, env.payload.lastActive);
}

function handleAgentStatus(msg: Extract<RelayControlMessage, { type: "agent_status" }>): void {
  useSessionStore.getState().setAgentStatus(msg.sessionId, msg.payload);
}

function handlePtyState(msg: Extract<RelayControlMessage, { type: "pty_state" }>): void {
  useSessionStore.getState().setPtyState(msg.sessionId, msg.payload);
}

function handleSessionHistoryResponse(
  msg: Extract<RelayControlMessage, { type: "session_history_response" }>,
): void {
  useSessionStore.getState().setHistorySessions(msg.sessions);
}

export function registerSessionDispatcher(): () => void {
  const relay = relayClientRef;
  if (!relay) {
    console.warn("registerSessionDispatcher called before relayClient bound; skipping");
    return () => {};
  }

  return relay.onMessage((msg: InboundMessage) => {
    switch (msg.type) {
      case "session_list":
        // Control 层的 session_list 是请求 (无 payload), 这里只处理 envelope 响应
        if ("payload" in msg) handleSessionList(msg);
        break;
      case "session_status":
        if ("payload" in msg) handleSessionStatus(msg);
        break;
      case "agent_status":
        handleAgentStatus(msg);
        break;
      case "pty_state":
        handlePtyState(msg);
        break;
      case "session_history_response":
        handleSessionHistoryResponse(msg);
        break;
      default:
        break;
    }
  });
}
