import type { Socket } from "node:net";
import {
  MessageEnvelopeSchema,
  ControlErrorCode,
  RelayControlSchema,
  SessionState,
  serializeControl,
  type AgentStatusPayload,
  type ControlMessage,
  type RelayControlMessage,
} from "@dev-anywhere/shared";
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
  getProviderEnv: () => NodeJS.ProcessEnv;
  getAgentCliSuggestions: () => Partial<Record<ProviderHookContext["provider"], string[]>>;
  setAgentCliPath: (provider: ProviderHookContext["provider"], path: string) => void;
  getPreviewRoots?: () => string[];
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
      previewRoots: deps.getPreviewRoots?.(),
    });
    this.resourceHandlers = new RelayResourceHandlers({
      relaySend: deps.relaySend,
      controlHandlers: deps.controlHandlers,
      sessionManager: deps.sessionManager,
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

  // shutdown 链路上提供单一 destroy 入口：把 sessionCreateHandler 内部 pending retry timer 清掉
  // 并 cleanup 已 spawn 但未 connect 的 worker 子进程，避免在 SIGTERM 之后变成孤儿。
  destroy(): void {
    this.sessionCreateHandler.destroy();
  }

  // 入站消息统一入口：proxy 收两类消息——relay control 与 envelope（user_input 这一种）。
  // 先按 envelope 试解析（discriminated union），失败再按 control 解析；各 handler 拿到
  // 强类型窄化后的消息，不再需要 `as string | undefined` / `as { ... }` 裸 cast。
  handle(rawMsg: Record<string, unknown>): void {
    const asEnvelope = MessageEnvelopeSchema.safeParse(rawMsg);
    if (asEnvelope.success && asEnvelope.data.type === "user_input") {
      try {
        this.inputHandlers.onUserInput(asEnvelope.data);
      } catch (err) {
        serviceLogger.warn({ type: "user_input", error: String(err) }, "Relay handler threw");
      }
      return;
    }

    const asControl = RelayControlSchema.safeParse(rawMsg);
    if (!asControl.success) {
      serviceLogger.warn(
        {
          type: typeof rawMsg.type === "string" ? rawMsg.type : "<missing>",
          controlIssues: asControl.error.issues.slice(0, 3),
        },
        "Relay message rejected by both envelope and control schemas",
      );
      return;
    }
    const msg = asControl.data;
    try {
      this.dispatch(msg);
    } catch (err) {
      serviceLogger.warn({ type: msg.type, error: String(err) }, "Relay handler threw");
    }
  }

  private dispatch(msg: RelayControlMessage): void {
    switch (msg.type) {
      case "remote_input_raw":
        this.inputHandlers.onRemoteInputRaw(msg);
        return;
      case "clipboard_image_upload":
        this.inputHandlers.onClipboardImageUpload(msg);
        return;
      case "image_preview_request":
        this.inputHandlers.onImagePreviewRequest(msg);
        return;
      case "file_download_request":
        this.inputHandlers.onFileDownloadRequest(msg);
        return;
      case "file_upload_request":
        void this.inputHandlers.onFileUploadRequest(msg);
        return;
      case "tool_approve":
        this.permissionHandlers.onToolApprove(msg);
        return;
      case "tool_deny":
        this.permissionHandlers.onToolDeny(msg);
        return;
      case "proxy_info_request":
        this.resourceHandlers.onProxyInfoRequest(msg);
        return;
      case "agent_cli_config_update":
        this.resourceHandlers.onAgentCliConfigUpdate(msg);
        return;
      case "dir_list_request":
        this.resourceHandlers.onDirListRequest(msg);
        return;
      case "dir_create_request":
        this.resourceHandlers.onDirCreateRequest(msg);
        return;
      case "session_create":
        this.sessionCreateHandler.onSessionCreate(msg);
        return;
      case "session_messages_request":
        this.historyHandlers.onSessionMessagesRequest(msg);
        return;
      case "session_resources_request":
        this.resourceHandlers.onSessionResourcesRequest(msg);
        return;
      case "agent_status_request":
        this.onAgentStatusRequest(msg);
        return;
      case "permission_request_delivered":
        this.permissionHandlers.onPermissionRequestDelivered(msg);
        return;
      case "session_terminate":
        this.onSessionTerminate(msg);
        return;
      case "session_rename":
        this.onSessionRename(msg);
        return;
      case "session_worker_abort":
        this.onSessionWorkerAbort(msg);
        return;
      case "session_history_request":
        this.deps.controlHandlers.handleSessionHistoryRequest({ requestId: msg.requestId });
        return;
      case "session_list":
        this.onSessionList();
        return;
      case "permission_mode_change":
        this.onPermissionModeChange(msg);
        return;
      case "session_subscribe":
        this.onSessionSubscribe(msg);
        return;
      case "terminal_resize_request":
        this.onTerminalResizeRequest(msg);
        return;
      default:
        // proxy_to_client 方向的 control 消息由 client/relay 处理，这里直接忽略。
        return;
    }
  }

  private onAgentStatusRequest(msg: ControlMessage<"agent_status_request">): void {
    const sid = msg.sessionId;
    const requestId = msg.requestId;
    if (sid) {
      const status = this.deps.agentStatusRegistry.get(sid);
      const statuses =
        status && this.deps.sessionManager.getSession(sid)
          ? [{ sessionId: sid, payload: status }]
          : [];
      this.deps.relaySend(serializeControl({ type: "agent_status_response", requestId, statuses }));
      serviceLogger.info({ sessionId: sid, count: statuses.length }, "Agent status snapshot sent");
      return;
    }

    const statuses: Array<{ sessionId: string; payload: AgentStatusPayload }> = [];
    for (const { sessionId, status } of this.deps.agentStatusRegistry.list()) {
      if (!this.deps.sessionManager.getSession(sessionId)) continue;
      statuses.push({ sessionId, payload: status });
    }
    this.deps.relaySend(serializeControl({ type: "agent_status_response", requestId, statuses }));
    serviceLogger.info({ count: statuses.length }, "Agent status snapshot sent");
  }

  private onSessionTerminate(msg: ControlMessage<"session_terminate">): void {
    const sid = msg.sessionId;
    if (!sid) return;

    const result = terminateSessionByOwnership(this.deps, sid);
    serviceLogger.info(
      { sessionId: sid, success: result.success, action: result.action },
      "Session termination handled via relay",
    );
  }

  private onSessionRename(msg: ControlMessage<"session_rename">): void {
    const sid = msg.sessionId;
    const requestId = msg.requestId;
    const result = this.deps.sessionManager.renameSession(sid, msg.name);
    if (result.success) {
      this.deps.broadcastSessionList();
      this.deps.relaySend(
        serializeControl({
          type: "session_rename_response",
          requestId,
          sessionId: sid,
          success: true,
          name: result.name,
        }),
      );
      return;
    }
    const sessionExists = Boolean(this.deps.sessionManager.getSession(sid));
    this.deps.relaySend(
      serializeControl({
        type: "session_rename_response",
        requestId,
        sessionId: sid,
        success: false,
        error:
          result.error ?? (sessionExists ? "Session title cannot be empty" : "Session not found"),
        errorCode: sessionExists ? ControlErrorCode.UNKNOWN : ControlErrorCode.SESSION_NOT_FOUND,
      }),
    );
  }

  private onSessionWorkerAbort(msg: ControlMessage<"session_worker_abort">): void {
    const sid = msg.sessionId;
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

  private onPermissionModeChange(msg: ControlMessage<"permission_mode_change">): void {
    const sid = msg.sessionId;
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

  private onSessionSubscribe(msg: ControlMessage<"session_subscribe">): void {
    const sid = msg.sessionId;
    const requestId = msg.requestId;
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

  private onTerminalResizeRequest(msg: ControlMessage<"terminal_resize_request">): void {
    const sid = msg.sessionId;
    const cols = msg.cols;
    const rows = msg.rows;
    if (!sid || !cols || !rows) return;
    if (!this.deps.hostedPtyRegistry.resize(sid, cols, rows)) {
      serviceLogger.debug({ sessionId: sid, cols, rows }, "Resize request ignored: not hosted PTY");
    }
  }
}
