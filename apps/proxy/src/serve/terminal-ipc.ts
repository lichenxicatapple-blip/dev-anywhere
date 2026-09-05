import type { Socket } from "node:net";
import {
  ControlErrorCode,
  encodeBinaryFrame,
  serializeControl,
  type AgentStatusPayload,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import {
  createIpcReader,
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
  type IpcMessage,
} from "../ipc/ipc-protocol.js";
import type { TerminalAdmissionContext } from "../ipc/terminal-admission.js";
import type { ProviderHookContext } from "../providers/index.js";
import type { HookEventRouter } from "./hook-event-router.js";
import { findCodexActiveWriter } from "../common/codex-active-writer.js";
import { codexActiveWriterMessage } from "../common/codex-session-conflict.js";
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
import { isProcessAlive } from "./service-files.js";
import type { TerminalSubscriptionBacklog } from "./terminal-subscription-backlog.js";

interface TerminalConnectionDeps {
  sessionManager: SessionManager;
  terminalSockets: Map<string, Socket>;
  terminalClaims: Map<string, Socket>;
  terminalSubscriptionBacklog: TerminalSubscriptionBacklog;
  relayConnection: RelayConnection;
  permissionBroker: PermissionBroker;
  hookEventRouter: HookEventRouter;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext | undefined;
  getProviderEnv: () => NodeJS.ProcessEnv;
  emitAgentStatus: (sessionId: string, phase: AgentStatusPayload["phase"]) => void;
  updateTerminalCwd: (sessionId: string, cwd: string) => boolean;
  resolveInterruptedApprovals: (sessionId: string) => void;
}

export function handleTerminalConnection(
  socket: Socket,
  deps: TerminalConnectionDeps,
  admission: TerminalAdmissionContext,
): void {
  const {
    sessionManager,
    terminalSockets,
    terminalClaims,
    terminalSubscriptionBacklog,
    relayConnection,
    permissionBroker,
    createHookContext,
    emitAgentStatus,
    updateTerminalCwd,
    resolveInterruptedApprovals,
  } = deps;

  const bridgeDeps: PtySessionBridgeDeps = {
    changeSessionState: (sessionId, next) =>
      changeSessionState(sessionManager, relayConnection, sessionId, next),
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getPendingApprovalCount: (sessionId) => permissionBroker.listSession(sessionId).length,
    resolveInterruptedApprovals,
    emitAgentStatus,
  };
  // A PTY socket must first complete the version-gated create handshake.  Keeping the
  // accepted identity on the socket prevents an old or unrelated process from skipping
  // session_create_request and registering/deregistering somebody else's session.
  let createHandshakeReceived = false;
  let protocolRejected = false;
  let acceptedRegistration: {
    sessionId: string;
    pid: number;
  } | null = null;
  let registeredSessionId: string | null = null;
  let admissionIntentChecked = false;
  type PtyClaimResult = ReturnType<SessionManager["claimPtySession"]>;
  const ownsRegisteredSession = (sessionId: string): boolean =>
    registeredSessionId === sessionId && terminalSockets.get(sessionId) === socket;
  const discardClaimMutation = (claim: PtyClaimResult | null): void => {
    if (claim === null || claim.source === "active") return;
    const sessionId = claim.session.id;
    if (terminalSockets.has(sessionId) || terminalClaims.has(sessionId)) return;
    sessionManager.releasePtyBinding(sessionId, claim.session.pid);
  };
  const discardUnregisteredClaim = (): void => {
    if (acceptedRegistration === null || registeredSessionId !== null) return;
    const { sessionId, pid } = acceptedRegistration;
    if (terminalClaims.get(sessionId) === socket) {
      terminalClaims.delete(sessionId);
      if (!terminalSockets.has(sessionId)) sessionManager.releasePtyBinding(sessionId, pid);
    }
    acceptedRegistration = null;
  };
  const rejectCreateHandshake = (error: string): void => {
    socket.end(
      serializeIpc({
        type: "session_create_response",
        success: false,
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        error,
      }),
    );
  };
  const matchesAdmissionIntent = (msg: IpcMessage): boolean => {
    if (msg.type !== "session_create_request") return false;
    if (admission.clientKind === "terminal-worker") {
      return admission.sessionId !== undefined && msg.sessionId === admission.sessionId;
    }
    return msg.kind === "agent" && msg.sessionId === admission.sessionId;
  };
  const rejectAdmissionIntent = (msg: IpcMessage): void => {
    protocolRejected = true;
    const error = "Terminal request does not match its admitted connection scope";
    if (msg.type === "session_create_request") {
      rejectCreateHandshake(error);
      return;
    }
    socket.end(
      serializeIpc({
        type: "error",
        code: "TERMINAL_ADMISSION_SCOPE_MISMATCH",
        message: error,
      }),
    );
  };

  createIpcReader(
    socket,
    (msg: IpcMessage) => {
      if (protocolRejected) return;
      if (!admissionIntentChecked) {
        admissionIntentChecked = true;
        if (!matchesAdmissionIntent(msg)) {
          rejectAdmissionIntent(msg);
          return;
        }
      }
      switch (msg.type) {
        case "session_create_request": {
          if (createHandshakeReceived) {
            serviceLogger.warn(
              { sessionId: acceptedRegistration?.sessionId ?? registeredSessionId },
              "Repeated terminal create handshake rejected",
            );
            discardUnregisteredClaim();
            rejectCreateHandshake("Terminal create handshake was already used on this connection");
            break;
          }
          createHandshakeReceived = true;
          const provider = msg.provider;
          let claim: PtyClaimResult | null = null;
          try {
            const identity = {
              cwd: msg.cwd,
              pid: msg.pid,
              ptyOwner:
                admission.clientKind === "terminal-worker"
                  ? ("proxy-hosted" as const)
                  : ("local-terminal" as const),
              ...(msg.name !== undefined ? { name: msg.name } : {}),
              ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            };
            claim =
              msg.kind === "terminal"
                ? sessionManager.claimPtySession({
                    ...identity,
                    kind: "terminal",
                    provider: "claude",
                    ptyOwner: "proxy-hosted",
                  })
                : sessionManager.claimPtySession({
                    ...identity,
                    kind: "agent",
                    provider,
                  });
            const { session } = claim;
            const hook =
              msg.kind === "terminal" || provider === "kimi"
                ? undefined
                : createHookContext(session.id, provider);
            acceptedRegistration = { sessionId: session.id, pid: msg.pid };
            terminalClaims.set(session.id, socket);
            socket.write(
              serializeIpc({
                type: "session_create_response",
                success: true,
                sessionId: session.id,
                protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
                ...(hook !== undefined ? { hook } : {}),
              }),
            );
            serviceLogger.info(
              { sessionId: session.id, mode: "pty", provider, source: claim.source },
              "PTY session create handshake accepted",
            );
          } catch (err) {
            if (acceptedRegistration !== null) discardUnregisteredClaim();
            else discardClaimMutation(claim);
            const error = err instanceof Error ? err.message : "Terminal session claim failed";
            serviceLogger.warn(
              { requestedSessionId: msg.sessionId, pid: msg.pid, provider, error },
              "Terminal create handshake rejected",
            );
            rejectCreateHandshake(error);
          }
          break;
        }

        case "pty_title_change": {
          if (!ownsRegisteredSession(msg.sessionId) || !sessionManager.getSession(msg.sessionId)) {
            break;
          }
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
          if (!ownsRegisteredSession(msg.sessionId)) break;
          updateTerminalCwd(msg.sessionId, msg.cwd);
          break;
        }

        case "pty_semantic_event": {
          if (!ownsRegisteredSession(msg.sessionId) || !sessionManager.getSession(msg.sessionId)) {
            break;
          }
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
          if (!ownsRegisteredSession(msg.sessionId) || !sessionManager.getSession(msg.sessionId)) {
            break;
          }
          relayConnection.sendRaw(
            serializeControl({
              type: "terminal_resize",
              sessionId: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
              outputSeq: msg.outputSeq,
            }),
          );
          break;
        }

        case "pty_register": {
          if (
            !acceptedRegistration ||
            terminalClaims.get(msg.sessionId) !== socket ||
            acceptedRegistration.sessionId !== msg.sessionId ||
            acceptedRegistration.pid !== msg.pid
          ) {
            serviceLogger.warn(
              { sessionId: msg.sessionId, pid: msg.pid },
              "PTY register ignored: version-gated create handshake missing",
            );
            break;
          }
          if (!sessionManager.getSession(msg.sessionId)) {
            serviceLogger.warn(
              { sessionId: msg.sessionId },
              "PTY register ignored: session missing",
            );
            break;
          }
          terminalSockets.set(msg.sessionId, socket);
          terminalClaims.delete(msg.sessionId);
          registeredSessionId = msg.sessionId;
          acceptedRegistration = null;
          socket.write(
            serializeIpc({
              type: "pty_approval_context",
              sessionId: msg.sessionId,
              waiting: permissionBroker.listSession(msg.sessionId).length > 0,
            }),
          );
          socket.write(
            serializeIpc({
              type: "bridge_status",
              connected: relayConnection.getStatus().connected,
            }),
          );
          broadcastSessionSync(relayConnection, sessionManager);
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
          if (!ownsRegisteredSession(msg.sessionId)) {
            serviceLogger.warn(
              { sessionId: msg.sessionId },
              "PTY deregister ignored: socket does not own session",
            );
            break;
          }
          terminalSubscriptionBacklog.delete(msg.sessionId);
          if (msg.runtimeError?.errorCode === ControlErrorCode.SESSION_ALREADY_ACTIVE) {
            const writer = findCodexActiveWriter(
              msg.runtimeError.nativeSessionId,
              deps.getProviderEnv(),
            );
            relayConnection.sendRaw(
              serializeControl({
                type: "session_runtime_error",
                sessionId: msg.sessionId,
                errorCode: msg.runtimeError.errorCode,
                error: codexActiveWriterMessage(writer?.pid),
                ...(writer ? { activeWriterPid: writer.pid } : {}),
              }),
            );
          } else if (msg.runtimeError) {
            relayConnection.sendRaw(
              serializeControl({
                type: "session_runtime_error",
                sessionId: msg.sessionId,
                errorCode: msg.runtimeError.errorCode,
                error: msg.runtimeError.error,
              }),
            );
          }
          sessionManager.terminateSession(msg.sessionId);
          terminalSockets.delete(msg.sessionId);
          registeredSessionId = null;
          serviceLogger[msg.exitCode === undefined || msg.exitCode === 0 ? "info" : "warn"](
            {
              sessionId: msg.sessionId,
              ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
              ...(msg.errorTail ? { errorTail: msg.errorTail } : {}),
            },
            "PTY session deregistered",
          );
          break;
        }

        case "pty_snapshot": {
          if (!ownsRegisteredSession(msg.sessionId) || !sessionManager.getSession(msg.sessionId)) {
            break;
          }
          relayConnection.sendRaw(
            serializeControl({
              type: "session_snapshot",
              sessionId: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
              data: msg.data,
              outputSeq: msg.outputSeq,
              requestId: msg.requestId,
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
      if (protocolRejected) return;
      if (!ownsRegisteredSession(sessionId) || !sessionManager.getSession(sessionId)) return;
      touchSessionActivity(sessionManager, relayConnection, sessionId);
      // Local-terminal lifecycle is owned by pty_semantic_event. Codex and Claude can emit
      // redraw/cursor output while waiting for input; promoting every byte frame to working
      // would reopen an already completed turn without a matching future turn_complete event.
      relayConnection.sendBinary(encodeBinaryFrame(sessionId, outputSeq, data));
    },
    (err, line) => {
      // 建立会话前的协议错误直接拒绝连接；已完成创建握手的长连接只丢弃坏行，
      // 避免单条损坏消息升级为整个终端断开。
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
      if (!createHandshakeReceived) {
        protocolRejected = true;
        socket.end();
      }
    },
  );

  socket.on("close", () => {
    discardUnregisteredClaim();
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
          if (!terminalClaims.has(sessionId)) {
            sessionManager.releasePtyBinding(sessionId, session.pid);
          }
          serviceLogger.info(
            { sessionId, pid: session.pid },
            "Terminal socket closed but process alive, skipping cleanup",
          );
          continue;
        }
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
