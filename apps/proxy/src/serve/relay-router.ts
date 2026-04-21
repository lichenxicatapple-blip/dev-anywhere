import type { Socket } from "node:net";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import { SessionState } from "@cc-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { sessionPaths, tildify } from "../common/paths.js";
import { serializeIpc } from "../ipc/ipc-protocol.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";
import type { ToolApprovalManager } from "./tool-approval-manager.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelayConnection } from "./relay-connection.js";
import type { JsonObserver } from "./json-observer.js";
import { readSessionMessages } from "./session-history.js";

interface RelayRouterDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  toolApprovalManager: ToolApprovalManager;
  controlHandlers: ControlMessageHandlers;
  relayConnection: RelayConnection;
  relaySend: (data: string) => void;
  terminalSockets: Map<string, Socket>;
  broadcastSessionList: () => void;
  broadcastSessionSync: (session: SessionInfo) => void;
  // user_input 注入触发 turn 开始（JSON 观察器）
  jsonObserver: JsonObserver;
}

// 按 type 分发入站 relay 消息到独立 handler。未知 type warn 不丢，schema 逐步收紧。
export class RelayRouter {
  constructor(private deps: RelayRouterDeps) {}

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
    user_input: (msg) => this.onUserInput(msg),
    remote_input_raw: (msg) => this.onRemoteInputRaw(msg),
    tool_approve: (msg) => this.onToolApprove(msg),
    tool_deny: (msg) => this.onToolDeny(msg),
    proxy_info_request: () => this.onProxyInfoRequest(),
    dir_list_request: (msg) => this.onDirListRequest(msg),
    dir_create_request: (msg) => this.onDirCreateRequest(msg),
    session_create: (msg) => this.onSessionCreate(msg),
    session_messages_request: (msg) => this.onSessionMessagesRequest(msg),
    session_resources_request: (msg) => this.onSessionResourcesRequest(msg),
    session_terminate: (msg) => this.onSessionTerminate(msg),
    session_worker_abort: (msg) => this.onSessionWorkerAbort(msg),
    session_history_request: () => this.deps.controlHandlers.handleSessionHistoryRequest(),
    session_list: () => this.onSessionList(),
    permission_mode_change: (msg) => this.onPermissionModeChange(msg),
    session_subscribe: (msg) => this.onSessionSubscribe(msg),
  };

  // ---------- handlers ----------

  private onUserInput(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      serviceLogger.warn({ sessionId }, "Remote input dropped: session not found");
      return;
    }

    const payload = msg.payload as { text?: string } | undefined;
    const text = payload?.text ?? "";

    if (session.mode === "json") {
      // user_input 是 JSON turn 的唯一入口，先推 WORKING 再 send；send 失败回滚不必要，
      // worker 会在下次消息往返时把状态拉回。
      this.deps.jsonObserver.onTurnStart(sessionId);
      const sent = this.deps.workerRegistry.send(sessionId, {
        type: "worker_input",
        content: text,
      });
      if (!sent) {
        serviceLogger.warn({ sessionId }, "Remote input dropped: JSON worker socket not available");
        return;
      }
      serviceLogger.info({ sessionId }, "Remote input forwarded to JSON worker");
      return;
    }

    const ts = this.deps.terminalSockets.get(sessionId);
    if (!ts?.writable) {
      serviceLogger.warn({ sessionId }, "Remote input dropped: PTY terminal socket not available");
      return;
    }
    ts.write(serializeIpc({ type: "pty_input", sessionId, data: text + "\r" }));
    serviceLogger.info({ sessionId }, "Remote input forwarded to PTY terminal");
  }

  private onRemoteInputRaw(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const data = msg.data as string | undefined;
    if (!sessionId || data === undefined) return;

    const ts = this.deps.terminalSockets.get(sessionId);
    if (!ts?.writable) {
      serviceLogger.warn({ sessionId }, "Raw PTY input dropped: terminal socket unavailable");
      return;
    }
    ts.write(serializeIpc({ type: "pty_input", sessionId, data }));
    serviceLogger.info({ sessionId, bytes: data.length }, "Raw PTY input forwarded");
  }

  private onToolApprove(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as
      | { toolId?: string; whitelistTool?: boolean; toolName?: string }
      | undefined;
    if (!sessionId || !payload?.toolId) return;

    const pending = this.deps.toolApprovalManager.take(payload.toolId);
    if (!pending) return;

    this.deps.workerRegistry.send(pending.sessionId, {
      type: "worker_approval_response",
      requestId: payload.toolId,
      behavior: "allow",
    });

    if (payload.whitelistTool) {
      const toolName = payload.toolName ?? "";
      if (toolName) {
        const whitelisted = this.deps.workerRegistry.send(pending.sessionId, {
          type: "worker_whitelist_add",
          toolName,
        });
        if (whitelisted) {
          serviceLogger.info(
            { sessionId: pending.sessionId, toolName },
            "Tool added to session whitelist via relay",
          );
        }
      }
    }
    serviceLogger.info(
      { sessionId, toolId: payload.toolId, whitelistTool: payload.whitelistTool },
      "Tool approved via relay",
    );
  }

  private onToolDeny(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as { toolId?: string; reason?: string } | undefined;
    if (!sessionId || !payload?.toolId) return;

    const reason = payload.reason ?? "Denied by remote user";
    const pending = this.deps.toolApprovalManager.take(payload.toolId);
    if (!pending) return;

    this.deps.workerRegistry.send(pending.sessionId, {
      type: "worker_approval_response",
      requestId: payload.toolId,
      behavior: "deny",
      message: reason,
    });
    serviceLogger.info({ sessionId, toolId: payload.toolId }, "Tool denied via relay");
  }

  private onProxyInfoRequest(): void {
    this.deps.relaySend(
      JSON.stringify({
        type: "proxy_info",
        homePath: homedir() || "/",
      }),
    );
  }

  private onDirListRequest(msg: Record<string, unknown>): void {
    this.deps.controlHandlers.handleDirListRequest({ path: (msg.path as string) ?? "" });
  }

  private onDirCreateRequest(msg: Record<string, unknown>): void {
    this.deps.controlHandlers.handleDirCreateRequest({ path: (msg.path as string) ?? "" });
  }

  private onSessionCreate(msg: Record<string, unknown>): void {
    const cwd = msg.cwd as string | undefined;
    if (!cwd) return;

    const resumeSessionId = msg.resumeSessionId as string | undefined;
    const permissionMode = msg.permissionMode as string | undefined;
    // streamDelta 来自 client 端系统设置 toggle（SessionCreatePayloadSchema 的 streamDelta）
    const streamDelta = msg.streamDelta === true;
    const name = tildify(cwd);
    // 先生成 ID 和启动 worker，连接成功后再注册 session
    const pendingId = nanoid();
    const workerPid = this.deps.workerRegistry.spawn(pendingId, {
      cwd,
      resumeSessionId,
      permissionMode,
      streamDelta,
    });

    const paths = sessionPaths(pendingId);
    let attempt = 0;
    const maxRetries = 20;
    const tryConnect = () => {
      attempt++;
      this.deps.workerRegistry.connect(pendingId, paths.workerSock).then((sock) => {
        if (sock) {
          // worker 连接成功，正式注册 session
          const session = this.deps.sessionManager.createSession(
            "json",
            cwd,
            workerPid,
            name,
            pendingId,
          );
          if (resumeSessionId) {
            this.deps.sessionManager.setClaudeSessionId(session.id, resumeSessionId);
          }
          this.deps.relaySend(
            JSON.stringify({ type: "session_create_response", sessionId: session.id }),
          );
          if (resumeSessionId) {
            this.pushHistoryMessages(session.id, resumeSessionId);
          }
          serviceLogger.info({ sessionId: session.id, cwd }, "JSON session created via relay");
          this.deps.controlHandlers.pushCommandList(session.id, cwd);
          this.deps.broadcastSessionSync(session);
          this.deps.broadcastSessionList();
        } else if (attempt < maxRetries) {
          setTimeout(tryConnect, Math.min(100 * attempt, 2000));
        } else {
          this.deps.relaySend(
            JSON.stringify({
              type: "session_create_response",
              sessionId: pendingId,
              error: "Worker failed to start",
            }),
          );
          serviceLogger.error({ sessionId: pendingId }, "Worker connection timeout via relay");
        }
      });
    };
    setTimeout(tryConnect, 100);
  }

  private pushHistoryMessages(sessionId: string, resumeSessionId: string): void {
    readSessionMessages(resumeSessionId)
      .then((messages) => {
        if (messages.length === 0) return;
        this.deps.relaySend(
          JSON.stringify({ type: "session_history_messages", sessionId, messages }),
        );
        serviceLogger.info(
          { sessionId, resumeSessionId, messageCount: messages.length },
          "History messages sent for resumed session",
        );
      })
      .catch((err) => {
        serviceLogger.warn(
          { sessionId, error: String(err) },
          "Failed to read session history messages",
        );
      });
  }

  private onSessionMessagesRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (session?.claudeSessionId) {
      readSessionMessages(session.claudeSessionId)
        .then((messages) => {
          this.deps.relaySend(
            JSON.stringify({ type: "session_history_messages", sessionId: sid, messages }),
          );
          serviceLogger.info(
            { sessionId: sid, messageCount: messages.length },
            "History messages sent on request",
          );
        })
        .catch((err) => {
          serviceLogger.warn(
            { sessionId: sid, error: String(err) },
            "Failed to read session history messages on request",
          );
          this.deps.relaySend(
            JSON.stringify({ type: "session_history_messages", sessionId: sid, messages: [] }),
          );
        });
    } else {
      // 非 resume 会话，没有历史消息，回空列表解除 loading
      this.deps.relaySend(
        JSON.stringify({ type: "session_history_messages", sessionId: sid, messages: [] }),
      );
    }

    // 推送该 session 当前 pending 的工具审批
    const approvals = this.deps.toolApprovalManager.listSession(sid);
    if (approvals.length > 0) {
      this.deps.relaySend(
        JSON.stringify({ type: "pending_approvals_push", sessionId: sid, approvals }),
      );
      serviceLogger.info({ sessionId: sid, count: approvals.length }, "Pending approvals pushed");
    }
  }

  private onSessionResourcesRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (!session?.cwd) {
      serviceLogger.warn({ sessionId: sid }, "Session resources request: no cwd available");
      return;
    }
    this.deps.controlHandlers.pushCommandList(sid, session.cwd);
    this.deps.controlHandlers.pushFileTree(sid, session.cwd);
    serviceLogger.info({ sessionId: sid, cwd: session.cwd }, "Session resources pushed");
  }

  private onSessionTerminate(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const result = this.deps.sessionManager.terminateSession(sid);
    this.deps.workerRegistry.send(sid, { type: "worker_stop" });
    this.deps.workerRegistry.delete(sid);
    this.deps.controlHandlers.cleanup(sid);
    serviceLogger.info({ sessionId: sid, success: result.success }, "Session terminated via relay");
    this.deps.broadcastSessionList();
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
      if (ts?.writable) {
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
    if (ts?.writable) {
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
    if (!sid) return;

    const ts = this.deps.terminalSockets.get(sid);
    if (ts?.writable) {
      ts.write(serializeIpc({ type: "pty_subscribe", sessionId: sid }));
      serviceLogger.info({ sessionId: sid }, "Subscribe forwarded to terminal");
    } else {
      serviceLogger.warn({ sessionId: sid }, "Subscribe failed: terminal socket not available");
    }
  }
}
