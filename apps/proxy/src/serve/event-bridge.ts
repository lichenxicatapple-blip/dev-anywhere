import {
  serializeControl,
  type AgentStatusPayload,
  type SessionState,
} from "@dev-anywhere/shared";
import { disposeSeqCounter, getSeqCounterFor } from "../common/seq-counter.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";
import {
  broadcastSessionList,
  changeSessionState,
  touchSessionActivity,
} from "./session-broadcast.js";

interface EventBridgeDeps {
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  agentStatusRegistry: AgentStatusRegistry;
  controlHandlers: ControlMessageHandlers;
  permissionBroker: { cleanupSession: (sessionId: string, reason: string) => void };
}

interface EventBridge {
  // 推动 session FSM 转换并广播 session_status；observer 通道按 session.mode 分别走 PTY/JSON 转换表。
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  // 节流式 lastActive 更新；与 changeSessionState 共用底层 push 逻辑。
  touchSessionActivity: (sessionId: string) => boolean;
  // 把 agent_status 推到 relay 并写到 registry，用于 client 重连后查询。
  emitAgentStatus: (sessionId: string, phase: AgentStatusPayload["phase"]) => void;
  // session 关闭时三件套清理：取消 control handlers 周期任务 / 删 agent_status / 广播会话列表。
  // session 本身的 manager.delete 由调用方负责（不同路径删的时机不同）。
  cleanupSessionResources: (sessionId: string) => void;
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
      seq: getSeqCounterFor(sessionId).next(),
      updatedAt: Date.now(),
    };
    deps.agentStatusRegistry.set(sessionId, payload);
    deps.relayConnection.sendRaw(serializeControl({ type: "agent_status", sessionId, payload }));
  };

  const cleanupSessionResources = (sessionId: string): void => {
    deps.controlHandlers.cleanup(sessionId);
    deps.agentStatusRegistry.delete(sessionId);
    disposeSeqCounter(sessionId);
    // hosted PTY 走的是 onSessionClosed = cleanupSessionResources, 不经过 worker socket
    // close → onDisconnect → permissionBroker.cleanupSession 那条链, 否则 hosted 模式下
    // 待审批工具会在 child 退出后留在 broker 永不释放, 客户端的 approval card 永远卡住。
    deps.permissionBroker.cleanupSession(sessionId, "Session closed");
    broadcastSessionList(deps.relayConnection, deps.sessionManager);
  };

  return {
    changeSessionState: changeState,
    touchSessionActivity: touchActivity,
    emitAgentStatus,
    cleanupSessionResources,
  };
}
