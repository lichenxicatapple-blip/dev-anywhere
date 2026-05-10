import {
  serializeControl,
  type AgentStatusPayload,
  type SessionState,
} from "@dev-anywhere/shared";
import { SeqCounter } from "../common/seq-counter.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";
import {
  changeSessionState,
  touchSessionActivity,
} from "./session-broadcast.js";

interface EventBridgeDeps {
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  agentStatusRegistry: AgentStatusRegistry;
}

export interface EventBridge {
  // 推动 session FSM 转换并广播 session_status；observer 通道按 session.mode 分别走 PTY/JSON 转换表。
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  // 节流式 lastActive 更新；与 changeSessionState 共用底层 push 逻辑。
  touchSessionActivity: (sessionId: string) => boolean;
  // 把 agent_status 推到 relay 并写到 registry，用于 client 重连后查询。
  emitAgentStatus: (sessionId: string, phase: AgentStatusPayload["phase"]) => void;
}

export function createEventBridge(deps: EventBridgeDeps): EventBridge {
  const changeState = (sessionId: string, next: SessionState): boolean =>
    changeSessionState(deps.sessionManager, deps.relayConnection, sessionId, next);

  const touchActivity = (sessionId: string): boolean =>
    touchSessionActivity(deps.sessionManager, deps.relayConnection, sessionId);

  const emitAgentStatus = (
    sessionId: string,
    phase: AgentStatusPayload["phase"],
  ): void => {
    const session = deps.sessionManager.getSession(sessionId);
    if (!session) return;
    const payload: AgentStatusPayload = {
      provider: session.provider,
      phase,
      seq: new SeqCounter(sessionId).next(),
      updatedAt: Date.now(),
    };
    deps.agentStatusRegistry.set(sessionId, payload);
    deps.relayConnection.sendRaw(serializeControl({ type: "agent_status", sessionId, payload }));
  };

  return {
    changeSessionState: changeState,
    touchSessionActivity: touchActivity,
    emitAgentStatus,
  };
}
