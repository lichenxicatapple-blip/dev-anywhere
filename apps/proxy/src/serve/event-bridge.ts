import { serializeControl, type AgentStatusPayload, type SessionState } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { disposeSeqCounter, getSeqCounterFor } from "../common/seq-counter.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";
import {
  broadcastSessionList,
  changeSessionState,
  changeTerminalCwd,
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
  // 纯终端通过 OSC 7 上报 cd 后的目录；更新文件解析基准并广播会话标题。
  updateTerminalCwd: (sessionId: string, cwd: string) => boolean;
  // 把 agent_status 推到 relay 并写到 registry，用于 client 重连后查询。
  emitAgentStatus: (sessionId: string, phase: AgentStatusPayload["phase"]) => void;
  // SessionManager.onSessionRemoved 的 runtime 清理出口：取消周期任务、清理观察状态与审批，
  // 最后广播权威会话列表。session 本身已由 SessionManager 删除。
  cleanupSessionResources: (sessionId: string) => void;
}

export function createEventBridge(deps: EventBridgeDeps): EventBridge {
  const changeState = (sessionId: string, next: SessionState): boolean =>
    changeSessionState(deps.sessionManager, deps.relayConnection, sessionId, next);

  const touchActivity = (sessionId: string): boolean =>
    touchSessionActivity(deps.sessionManager, deps.relayConnection, sessionId);

  const updateTerminalCwd = (sessionId: string, cwd: string): boolean =>
    changeTerminalCwd(deps.sessionManager, deps.relayConnection, sessionId, cwd);

  const emitAgentStatus = (sessionId: string, phase: AgentStatusPayload["phase"]): void => {
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
    // 每步独立 try/catch: 任意中间步骤抛异常都不能阻断最后的 broadcastSessionList。
    // 一旦广播丢失, web 不知道 session 已删, 列表残留 + 后续给该 session 的请求全
    // hang 到超时。
    const safe = (fn: () => void, step: string): void => {
      try {
        fn();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        serviceLogger.warn(
          {
            sessionId,
            step,
            err: { message: error.message, stack: error.stack, cause: error.cause },
          },
          "Session cleanup step failed; continuing",
        );
      }
    };
    safe(() => deps.controlHandlers.cleanup(sessionId), "controlHandlers.cleanup");
    safe(() => deps.agentStatusRegistry.delete(sessionId), "agentStatusRegistry.delete");
    safe(() => disposeSeqCounter(sessionId), "disposeSeqCounter");
    // 所有 ownership 都通过 SessionManager.onSessionRemoved 到达这里，不能依赖某一种
    // worker/socket close 事件，否则另一种会话形态会漏掉 pending approval。
    safe(
      () => deps.permissionBroker.cleanupSession(sessionId, "Session closed"),
      "permissionBroker.cleanupSession",
    );
    safe(
      () => broadcastSessionList(deps.relayConnection, deps.sessionManager),
      "broadcastSessionList",
    );
  };

  return {
    changeSessionState: changeState,
    touchSessionActivity: touchActivity,
    updateTerminalCwd,
    emitAgentStatus,
    cleanupSessionResources,
  };
}
