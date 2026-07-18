import type { Socket } from "node:net";
import { encodeBinaryFrame, serializeControl, type AgentStatusPayload } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { createIpcReader, serializeIpc, type IpcMessage } from "../ipc/ipc-protocol.js";
import type { ProviderHookContext } from "../providers/index.js";
import type { HookEventRouter } from "./hook-event-router.js";
import type { HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { PermissionBroker } from "./permission-broker.js";
import { applyPtyStateToSession } from "./pty-session-bridge.js";
import type { PtySessionBridgeDeps } from "./pty-session-bridge.js";
import type { RelayConnection } from "./relay-connection.js";
import {
  broadcastSessionList,
  broadcastSessionSync,
  changeSessionState,
  touchSessionActivity,
} from "./session-broadcast.js";
import type { SessionManager } from "./session-manager.js";
import { terminateSessionByOwnership } from "./session-termination.js";
import type { WorkerRegistry } from "./worker-registry.js";
import { isProcessAlive } from "./service-files.js";
import type { TerminalSubscriptionBacklog } from "./terminal-subscription-backlog.js";

interface TerminalConnectionDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  terminalSockets: Map<string, Socket>;
  terminalSubscriptionBacklog: TerminalSubscriptionBacklog;
  hostedPtyRegistry: HostedPtyRegistry;
  relayConnection: RelayConnection;
  permissionBroker: PermissionBroker;
  hookEventRouter: HookEventRouter;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext;
  emitAgentStatus: (sessionId: string, phase: AgentStatusPayload["phase"]) => void;
  updateTerminalCwd: (sessionId: string, cwd: string) => boolean;
  resolveInterruptedApprovals: (sessionId: string) => void;
  config: Extract<IpcMessage, { type: "service_status_response" }>["config"];
}

export function handleTerminalConnection(socket: Socket, deps: TerminalConnectionDeps): void {
  const {
    sessionManager,
    workerRegistry,
    terminalSockets,
    terminalSubscriptionBacklog,
    hostedPtyRegistry,
    relayConnection,
    permissionBroker,
    createHookContext,
    emitAgentStatus,
    updateTerminalCwd,
    resolveInterruptedApprovals,
    config,
  } = deps;

  const bridgeDeps: PtySessionBridgeDeps = {
    changeSessionState: (sessionId, next) =>
      changeSessionState(sessionManager, relayConnection, sessionId, next),
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getPendingApprovalCount: (sessionId) => permissionBroker.listSession(sessionId).length,
    resolveInterruptedApprovals,
    emitAgentStatus,
  };

  createIpcReader(
    socket,
    (msg: IpcMessage) => {
      switch (msg.type) {
        case "session_create_request": {
          if (msg.mode !== "pty") {
            socket.write(
              serializeIpc({
                type: "session_create_response",
                sessionId: "",
                error: `Unsupported mode via IPC: ${msg.mode}`,
              }),
            );
            break;
          }
          const provider = msg.provider;
          const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
          const session =
            existing ??
            sessionManager.createSession(
              "pty",
              msg.cwd,
              msg.pid,
              msg.name,
              msg.sessionId,
              provider,
              "local-terminal",
              undefined,
              msg.kind,
            );
          if (existing) {
            sessionManager.setPid(session.id, msg.pid);
          }
          const hook =
            msg.kind === "terminal" ? undefined : createHookContext(session.id, provider);
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
              ...(hook !== undefined ? { hook } : {}),
            }),
          );
          serviceLogger.info(
            { sessionId: session.id, mode: "pty", provider },
            "PTY session created",
          );
          break;
        }

        case "service_status_request": {
          const relayStatus = relayConnection.getStatus();
          const sessions = sessionManager.listSessions();
          socket.write(
            serializeIpc({
              type: "service_status_response",
              config,
              relay: relayStatus,
              sessions: sessions.map((s) => ({
                id: s.id,
                mode: s.mode,
                provider: s.provider,
                state: s.state,
                createdAt: new Date(s.createdAt).toISOString(),
                ...(s.name !== undefined ? { name: s.name } : {}),
                hasWorker: workerRegistry.has(s.id),
              })),
            }),
          );
          break;
        }

        case "pty_title_change": {
          if (!sessionManager.getSession(msg.sessionId)) break;
          relayConnection.sendRaw(
            serializeControl({
              type: "terminal_title",
              sessionId: msg.sessionId,
              title: msg.title,
            }),
          );
          break;
        }

        case "pty_cwd_change": {
          updateTerminalCwd(msg.sessionId, msg.cwd);
          break;
        }

        case "pty_semantic_event": {
          if (!sessionManager.getSession(msg.sessionId)) break;
          const logPayload = {
            sessionId: msg.sessionId,
            state: msg.state,
            seq: msg.seq,
            ...(msg.title !== undefined ? { title: msg.title } : {}),
            ...(msg.tool !== undefined ? { tool: msg.tool } : {}),
          };
          if (msg.state === "approval_wait" || msg.state === "turn_complete") {
            serviceLogger.info(logPayload, "PTY semantic event received");
          } else {
            serviceLogger.debug(logPayload, "PTY semantic event received");
          }
          applyPtyStateToSession(bridgeDeps, msg.sessionId, msg.state);
          relayConnection.sendRaw(
            serializeControl({
              type: "pty_state",
              sessionId: msg.sessionId,
              payload: {
                state: msg.state,
                seq: msg.seq,
                ...(msg.title !== undefined ? { title: msg.title } : {}),
                ...(msg.tool !== undefined ? { tool: msg.tool } : {}),
              },
            }),
          );
          break;
        }

        case "pty_resize": {
          if (!sessionManager.getSession(msg.sessionId)) break;
          relayConnection.sendRaw(
            serializeControl({
              type: "terminal_resize",
              sessionId: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
            }),
          );
          break;
        }

        case "session_terminate_request": {
          const result = terminateSessionByOwnership(
            {
              sessionManager,
              workerRegistry,
              terminalSockets,
              hostedPtyRegistry,
            },
            msg.sessionId,
          );
          socket.write(
            serializeIpc({
              type: "session_terminate_response",
              sessionId: msg.sessionId,
              success: result.success,
            }),
          );
          serviceLogger.info(
            { sessionId: msg.sessionId, success: result.success, action: result.action },
            "Session termination request handled",
          );
          break;
        }

        case "pty_register": {
          if (!sessionManager.getSession(msg.sessionId)) {
            serviceLogger.warn(
              { sessionId: msg.sessionId },
              "PTY register ignored: session missing",
            );
            break;
          }
          sessionManager.setPid(msg.sessionId, msg.pid);
          terminalSockets.set(msg.sessionId, socket);
          socket.write(
            serializeIpc({
              type: "bridge_status",
              connected: relayConnection.getStatus().connected,
            }),
          );
          const session = sessionManager.getSession(msg.sessionId);
          if (session) {
            broadcastSessionSync(relayConnection, session);
          }
          broadcastSessionList(relayConnection, sessionManager);
          const pendingSubscribes = terminalSubscriptionBacklog.take(msg.sessionId);
          for (const pending of pendingSubscribes) {
            if (!socket.writable) break;
            socket.write(
              serializeIpc({
                type: "pty_subscribe",
                sessionId: msg.sessionId,
                requestId: pending.requestId,
              }),
            );
          }
          if (pendingSubscribes.length > 0) {
            serviceLogger.info(
              { sessionId: msg.sessionId, count: pendingSubscribes.length },
              "Pending PTY subscribes forwarded to terminal",
            );
          }
          serviceLogger.info({ sessionId: msg.sessionId }, "PTY session registered");
          break;
        }

        case "pty_deregister": {
          terminalSubscriptionBacklog.delete(msg.sessionId);
          relayConnection.sendRaw(
            serializeControl({
              type: "pty_state",
              sessionId: msg.sessionId,
              payload: { state: "turn_complete" },
            }),
          );
          sessionManager.terminateSession(msg.sessionId);
          terminalSockets.delete(msg.sessionId);
          serviceLogger.info({ sessionId: msg.sessionId }, "PTY session deregistered");
          break;
        }

        case "pty_input": {
          if (!sessionManager.getSession(msg.sessionId)) break;
          const targetSocket = terminalSockets.get(msg.sessionId);
          if (
            msg.traceId
              ? hostedPtyRegistry.write(msg.sessionId, msg.data, msg.traceId)
              : hostedPtyRegistry.write(msg.sessionId, msg.data)
          ) {
            break;
          }
          if (targetSocket?.writable) {
            targetSocket.write(
              serializeIpc({
                type: "pty_input",
                sessionId: msg.sessionId,
                data: msg.data,
                traceId: msg.traceId,
              }),
            );
          }
          break;
        }

        case "session_status_update": {
          changeSessionState(sessionManager, relayConnection, msg.sessionId, msg.state);
          break;
        }

        case "pty_snapshot": {
          if (!sessionManager.getSession(msg.sessionId)) break;
          relayConnection.sendRaw(
            serializeControl({
              type: "session_snapshot",
              sessionId: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
              data: msg.data,
              outputSeq: msg.outputSeq,
              ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
            }),
          );
          serviceLogger.info(
            { sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows },
            "Session snapshot forwarded to relay",
          );
          break;
        }

        default: {
          serviceLogger.warn({ type: (msg as IpcMessage).type }, "Unhandled IPC message type");
        }
      }
    },
    (sessionId, data, outputSeq) => {
      if (!sessionManager.getSession(sessionId)) return;
      touchSessionActivity(sessionManager, relayConnection, sessionId);
      // Local-terminal lifecycle is owned by pty_semantic_event. Codex and Claude can emit
      // redraw/cursor output while waiting for input; promoting every byte frame to working
      // would reopen an already completed turn without a matching future turn_complete event.
      relayConnection.sendBinary(encodeBinaryFrame(sessionId, outputSeq, data));
    },
    (err, line) => {
      // 单条 IPC 行 schema 失败时 warn-skip，不让它升级为 socket error 触发整个 terminal 断开。
      // err.cause 暴露 JSON.parse / zod 的原始报错; line 截断 200 字符避免日志爆掉但留够字段
      // 取证。
      const cause = err instanceof Error ? err.cause : undefined;
      serviceLogger.warn(
        {
          err: err.message,
          cause: cause instanceof Error ? cause.message : cause,
          lineLen: line.length,
          linePreview: line.slice(0, 200),
        },
        "Terminal IPC message dropped (parse/schema error)",
      );
    },
  );

  socket.on("close", () => {
    for (const [sessionId, terminalSocket] of terminalSockets) {
      if (terminalSocket === socket) {
        terminalSockets.delete(sessionId);
        terminalSubscriptionBacklog.delete(sessionId);
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          serviceLogger.info({ sessionId }, "Terminal socket closed, session already cleaned");
          continue;
        }
        if (session.mode === "pty" && session.pid && isProcessAlive(session.pid)) {
          serviceLogger.info(
            { sessionId, pid: session.pid },
            "Terminal socket closed but process alive, skipping cleanup",
          );
          continue;
        }
        relayConnection.sendRaw(
          serializeControl({
            type: "pty_state",
            sessionId,
            payload: { state: "turn_complete" },
          }),
        );
        sessionManager.terminateSession(sessionId);
        serviceLogger.info(
          { sessionId },
          "PTY session cleaned up on socket close (crash fallback)",
        );
      }
    }
  });

  socket.on("error", (err) => {
    serviceLogger.warn({ error: String(err) }, "Client socket error");
  });
}
