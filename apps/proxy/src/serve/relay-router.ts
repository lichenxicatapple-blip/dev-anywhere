import type { Socket } from "node:net";
import { SessionState, type AgentStatusPayload } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { serializeIpc } from "../ipc/ipc-protocol.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelayConnection } from "./relay-connection.js";
import type { JsonObserver } from "./json-observer.js";
import type { ProviderHookContext } from "../providers/index.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { HookEventRouter } from "./hook-event-router.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import type { HostedPtyRegistry } from "./hosted-pty-registry.js";
import { terminateSessionByOwnership } from "./session-termination.js";
import { RelayInputHandlers } from "./relay-input-handlers.js";
import { RelayHistoryHandlers } from "./relay-history-handlers.js";
import { RelayPermissionHandlers } from "./relay-permission-handlers.js";
import { RelayResourceHandlers } from "./relay-resource-handlers.js";
import { RelaySessionCreateHandler } from "./relay-session-create-handler.js";
import type { RelaySend } from "./relay-router-types.js";

interface RelayRouterDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  controlHandlers: ControlMessageHandlers;
  relayConnection: RelayConnection;
  relaySend: RelaySend;
  terminalSockets: Map<string, Socket>;
  hostedPtyRegistry: HostedPtyRegistry;
  broadcastSessionList: () => void;
  broadcastSessionSync: (session: SessionInfo) => void;
  // user_input 注入触发 turn 开始（JSON 观察器）
  jsonObserver: JsonObserver;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext;
  cleanupHookContext: (sessionId: string) => void;
  permissionBroker: PermissionBroker;
  hookEventRouter: HookEventRouter;
  agentStatusRegistry: AgentStatusRegistry;
  envName?: string;
  getProviderEnv: () => NodeJS.ProcessEnv;
  getAgentCliSuggestions: () => Partial<Record<ProviderHookContext["provider"], string[]>>;
  setAgentCliPath: (provider: ProviderHookContext["provider"], path: string) => void;
}

// 按 type 分发入站 relay 消息到独立 handler。未知 type warn 不丢，schema 逐步收紧。
export class RelayRouter {
  private readonly historyHandlers: RelayHistoryHandlers;
  private readonly inputHandlers: RelayInputHandlers;
  private readonly permissionHandlers: RelayPermissionHandlers;
  private readonly resourceHandlers: RelayResourceHandlers;
  private readonly sessionCreateHandler: RelaySessionCreateHandler;

  constructor(private deps: RelayRouterDeps) {
    this.historyHandlers = new RelayHistoryHandlers({
      relaySend: deps.relaySend,
      sessionManager: deps.sessionManager,
      permissionBroker: deps.permissionBroker,
    });
    this.inputHandlers = new RelayInputHandlers({
      sessionManager: deps.sessionManager,
      workerRegistry: deps.workerRegistry,
      relayConnection: deps.relayConnection,
      terminalSockets: deps.terminalSockets,
      hostedPtyRegistry: deps.hostedPtyRegistry,
      jsonObserver: deps.jsonObserver,
    });
    this.resourceHandlers = new RelayResourceHandlers({
      relaySend: deps.relaySend,
      controlHandlers: deps.controlHandlers,
      sessionManager: deps.sessionManager,
      envName: deps.envName,
      getProviderEnv: deps.getProviderEnv,
      getAgentCliSuggestions: deps.getAgentCliSuggestions,
      setAgentCliPath: deps.setAgentCliPath,
    });
    this.permissionHandlers = new RelayPermissionHandlers({
      relaySend: deps.relaySend,
      permissionBroker: deps.permissionBroker,
      hookEventRouter: deps.hookEventRouter,
      workerRegistry: deps.workerRegistry,
    });
    this.sessionCreateHandler = new RelaySessionCreateHandler({
      relaySend: deps.relaySend,
      workerRegistry: deps.workerRegistry,
      sessionManager: deps.sessionManager,
      hostedPtyRegistry: deps.hostedPtyRegistry,
      controlHandlers: deps.controlHandlers,
      permissionBroker: deps.permissionBroker,
      agentStatusRegistry: deps.agentStatusRegistry,
      getProviderEnv: deps.getProviderEnv,
      createHookContext: deps.createHookContext,
      cleanupHookContext: deps.cleanupHookContext,
      broadcastSessionSync: deps.broadcastSessionSync,
      broadcastSessionList: deps.broadcastSessionList,
    });
  }

  handle(parsed: Record<string, unknown>): void {
    const type = parsed.type as string | undefined;
    if (!type) {
      serviceLogger.warn("Relay message without type discriminator");
      return;
    }

    const handler = this.handlers[type];
    if (!handler) {
      serviceLogger.warn({ type }, "Unhandled relay message type");
      return;
    }

    try {
      handler.call(this, parsed);
    } catch (err) {
      serviceLogger.warn({ type, error: String(err) }, "Relay handler threw");
    }
  }

  private readonly handlers: Record<string, (msg: Record<string, unknown>) => void> = {
    user_input: (msg) => this.inputHandlers.onUserInput(msg),
    remote_input_raw: (msg) => this.inputHandlers.onRemoteInputRaw(msg),
    tool_approve: (msg) => this.permissionHandlers.onToolApprove(msg),
    tool_deny: (msg) => this.permissionHandlers.onToolDeny(msg),
    proxy_info_request: (msg) => this.resourceHandlers.onProxyInfoRequest(msg),
    agent_cli_config_update: (msg) => this.resourceHandlers.onAgentCliConfigUpdate(msg),
    dir_list_request: (msg) => this.resourceHandlers.onDirListRequest(msg),
    dir_create_request: (msg) => this.resourceHandlers.onDirCreateRequest(msg),
    session_create: (msg) => this.sessionCreateHandler.onSessionCreate(msg),
    session_messages_request: (msg) => this.historyHandlers.onSessionMessagesRequest(msg),
    session_resources_request: (msg) => this.resourceHandlers.onSessionResourcesRequest(msg),
    agent_status_request: (msg) => this.onAgentStatusRequest(msg),
    permission_request_delivered: (msg) =>
      this.permissionHandlers.onPermissionRequestDelivered(msg),
    session_terminate: (msg) => this.onSessionTerminate(msg),
    session_worker_abort: (msg) => this.onSessionWorkerAbort(msg),
    session_history_request: (msg) =>
      this.deps.controlHandlers.handleSessionHistoryRequest({
        requestId: msg.requestId as string | undefined,
      }),
    session_list: () => this.onSessionList(),
    permission_mode_change: (msg) => this.onPermissionModeChange(msg),
    session_subscribe: (msg) => this.onSessionSubscribe(msg),
    terminal_resize_request: (msg) => this.onTerminalResizeRequest(msg),
  };

  private onAgentStatusRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    const requestId = msg.requestId as string | undefined;
    if (sid) {
      const status = this.deps.agentStatusRegistry.get(sid);
      const statuses =
        status && this.deps.sessionManager.getSession(sid)
          ? [{ sessionId: sid, payload: status }]
          : [];
      this.deps.relaySend(JSON.stringify({ type: "agent_status_response", requestId, statuses }));
      serviceLogger.info({ sessionId: sid, count: statuses.length }, "Agent status snapshot sent");
      return;
    }

    const statuses: Array<{ sessionId: string; payload: AgentStatusPayload }> = [];
    for (const { sessionId, status } of this.deps.agentStatusRegistry.list()) {
      if (!this.deps.sessionManager.getSession(sessionId)) continue;
      statuses.push({ sessionId, payload: status });
    }
    this.deps.relaySend(JSON.stringify({ type: "agent_status_response", requestId, statuses }));
    serviceLogger.info({ count: statuses.length }, "Agent status snapshot sent");
  }

  private onSessionTerminate(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const result = terminateSessionByOwnership(this.deps, sid);
    serviceLogger.info(
      { sessionId: sid, success: result.success, action: result.action },
      "Session termination handled via relay",
    );
    if (result.action !== "terminate_hosted_pty") this.deps.broadcastSessionList();
  }

  private onSessionWorkerAbort(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (!session) {
      serviceLogger.warn({ sessionId: sid }, "session_worker_abort: session not found");
      return;
    }
    if (session.state === SessionState.TERMINATED) {
      serviceLogger.info({ sessionId: sid }, "session_worker_abort: already terminated, dropping");
      return;
    }

    if (session.mode === "pty") {
      // PTY 会话直接把 Ctrl+C 写入 PTY stdin，避免杀掉 terminal wrapper 进程
      const ts = this.deps.terminalSockets.get(sid);
      if (this.deps.hostedPtyRegistry.write(sid, "\x03")) {
        serviceLogger.info({ sessionId: sid }, "session_worker_abort: Ctrl+C sent to hosted PTY");
      } else if (ts?.writable) {
        ts.write(serializeIpc({ type: "pty_input", sessionId: sid, data: "\x03" }));
        serviceLogger.info({ sessionId: sid }, "session_worker_abort: Ctrl+C sent to PTY");
      } else {
        serviceLogger.warn(
          { sessionId: sid },
          "session_worker_abort: PTY terminal socket unavailable",
        );
      }
      return;
    }

    try {
      process.kill(session.pid, "SIGINT");
      serviceLogger.info(
        { sessionId: sid, pid: session.pid },
        "session_worker_abort: SIGINT sent to worker",
      );
    } catch (err) {
      serviceLogger.warn(
        { sessionId: sid, pid: session.pid, error: String(err) },
        "session_worker_abort: kill failed",
      );
    }
  }

  private onSessionList(): void {
    this.deps.broadcastSessionList();
    serviceLogger.info("Session list sent via relay");
  }

  private onPermissionModeChange(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    const mode = msg.mode;
    if (!sid) {
      serviceLogger.info(
        { mode },
        "Permission mode change received via relay (global, no sessionId)",
      );
      return;
    }

    const session = this.deps.sessionManager.getSession(sid);
    if (session?.mode !== "pty") {
      serviceLogger.info(
        { sessionId: sid, mode },
        "Permission mode change received for JSON session (no-op, not supported)",
      );
      return;
    }

    // PTY 会话：发 Shift+Tab (CSI Z) 让 claude CLI 循环 permission mode
    // mode 字段当前保留但不使用 —— Claude CLI 仅支持循环键，无法一键直选档位
    const ts = this.deps.terminalSockets.get(sid);
    if (this.deps.hostedPtyRegistry.write(sid, "\x1b[Z")) {
      serviceLogger.info(
        { sessionId: sid, mode },
        "Permission mode cycle: Shift+Tab sent to hosted PTY",
      );
    } else if (ts?.writable) {
      ts.write(serializeIpc({ type: "pty_input", sessionId: sid, data: "\x1b[Z" }));
      serviceLogger.info({ sessionId: sid, mode }, "Permission mode cycle: Shift+Tab sent to PTY");
    } else {
      serviceLogger.warn(
        { sessionId: sid },
        "Permission mode cycle: PTY terminal socket unavailable",
      );
    }
  }

  private onSessionSubscribe(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    const requestId = msg.requestId as string | undefined;
    if (!sid) return;

    const ts = this.deps.terminalSockets.get(sid);
    if (this.deps.hostedPtyRegistry.snapshot(sid, requestId)) {
      serviceLogger.info({ sessionId: sid, requestId }, "Subscribe handled by hosted PTY");
    } else if (ts?.writable) {
      ts.write(serializeIpc({ type: "pty_subscribe", sessionId: sid, requestId }));
      serviceLogger.info({ sessionId: sid, requestId }, "Subscribe forwarded to terminal");
    } else {
      serviceLogger.warn({ sessionId: sid }, "Subscribe failed: terminal socket not available");
    }
  }

  private onTerminalResizeRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    const cols = msg.cols as number | undefined;
    const rows = msg.rows as number | undefined;
    if (!sid || !cols || !rows) return;
    if (!this.deps.hostedPtyRegistry.resize(sid, cols, rows)) {
      serviceLogger.debug({ sessionId: sid, cols, rows }, "Resize request ignored: not hosted PTY");
    }
  }
}
