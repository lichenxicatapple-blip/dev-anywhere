import { rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { sessionPaths, tildify } from "../common/paths.js";
import type { ProviderHookContext, ProviderId } from "../providers/index.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import { buildHostedPtyArgs, type HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import { readSessionMessages } from "./session-history.js";
import type { WorkerRegistry } from "./worker-registry.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import { classifyPathError } from "./path-errors.js";

interface RelaySessionCreateHandlerDeps {
  relaySend: RelaySend;
  workerRegistry: WorkerRegistry;
  sessionManager: SessionManager;
  hostedPtyRegistry: HostedPtyRegistry;
  controlHandlers: ControlMessageHandlers;
  permissionBroker: PermissionBroker;
  agentStatusRegistry: AgentStatusRegistry;
  getProviderEnv: () => NodeJS.ProcessEnv;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext;
  cleanupHookContext: (sessionId: string) => void;
  broadcastSessionSync: (session: SessionInfo) => void;
  broadcastSessionList: () => void;
}

interface SessionCwdValidationError {
  message: string;
  code: ControlErrorCode;
}

function validateSessionCwd(cwd: unknown): SessionCwdValidationError | null {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return { message: "请输入工作目录", code: ControlErrorCode.INVALID_PATH };
  }
  const trimmed = cwd.trim();
  if (!isAbsolute(trimmed)) {
    return { message: "工作目录必须是绝对路径", code: ControlErrorCode.INVALID_PATH };
  }
  try {
    const stat = statSync(trimmed);
    return stat.isDirectory()
      ? null
      : { message: "工作目录不是目录", code: ControlErrorCode.PATH_NOT_DIRECTORY };
  } catch (err) {
    return {
      message: `工作目录不存在或不可访问: ${trimmed}`,
      code: classifyPathError(err),
    };
  }
}

export class RelaySessionCreateHandler {
  constructor(private readonly deps: RelaySessionCreateHandlerDeps) {}

  onSessionCreate(msg: Record<string, unknown>): void {
    const requestId = msg.requestId as string | undefined;
    const cwd = msg.cwd as string | undefined;
    const cwdError = validateSessionCwd(cwd);
    if (cwdError) {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId,
          sessionId: "",
          error: cwdError.message,
          errorCode: cwdError.code,
        }),
      );
      serviceLogger.warn({ cwd }, "Session create rejected: invalid cwd");
      return;
    }
    const sessionCwd = typeof cwd === "string" ? cwd.trim() : "";

    const provider = msg.provider as ProviderId | undefined;
    const mode = (msg.mode as "json" | "pty" | undefined) ?? "json";
    const permissionMode = msg.permissionMode as string | undefined;
    if (mode === "pty") {
      this.createHostedPtySession(msg, sessionCwd, provider ?? "claude", permissionMode);
      return;
    }

    if (provider !== "claude") {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId,
          sessionId: "",
          errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
          error:
            provider === "codex"
              ? "Codex chat sessions are not supported yet; start a Codex terminal session instead."
              : "Unsupported provider for JSON session.",
        }),
      );
      serviceLogger.warn({ provider }, "JSON session create rejected for unsupported provider");
      return;
    }

    const resumeSessionId = msg.resumeSessionId as string | undefined;
    const streamDelta = msg.streamDelta === true;
    const name = tildify(sessionCwd);
    const pendingId = nanoid();
    const hook = this.deps.createHookContext(pendingId, provider);
    const workerPid = this.deps.workerRegistry.spawn(pendingId, {
      cwd: sessionCwd,
      resumeSessionId,
      permissionMode,
      streamDelta,
      hook,
    });

    const paths = sessionPaths(pendingId);
    let attempt = 0;
    const maxRetries = 20;
    const tryConnect = () => {
      attempt++;
      this.deps.workerRegistry.connect(pendingId, paths.workerSock).then((sock) => {
        if (sock) {
          const session = this.deps.sessionManager.createSession(
            "json",
            sessionCwd,
            workerPid,
            name,
            pendingId,
            provider,
          );
          if (resumeSessionId) {
            this.deps.sessionManager.setClaudeSessionId(session.id, resumeSessionId);
          }
          this.deps.relaySend(
            JSON.stringify({ type: "session_create_response", requestId, sessionId: session.id }),
          );
          if (resumeSessionId) {
            this.pushHistoryMessages(session.id, resumeSessionId);
          }
          serviceLogger.info(
            { sessionId: session.id, cwd: sessionCwd },
            "JSON session created via relay",
          );
          this.deps.controlHandlers.pushCommandList(session.id, sessionCwd);
          this.deps.broadcastSessionSync(session);
          this.deps.broadcastSessionList();
        } else if (attempt < maxRetries) {
          setTimeout(tryConnect, Math.min(100 * attempt, 2000));
        } else {
          this.cleanupPendingJsonSession(pendingId);
          this.deps.relaySend(
            JSON.stringify({
              type: "session_create_response",
              requestId,
              sessionId: pendingId,
              errorCode: ControlErrorCode.WORKER_START_FAILED,
              error: "Worker failed to start",
            }),
          );
          serviceLogger.error({ sessionId: pendingId }, "Worker connection timeout via relay");
        }
      });
    };
    setTimeout(tryConnect, 100);
  }

  private cleanupPendingJsonSession(sessionId: string): void {
    const killed = this.deps.workerRegistry.terminateProcess(sessionId);
    const paths = sessionPaths(sessionId);
    rmSync(paths.dir, { recursive: true, force: true });
    this.deps.cleanupHookContext(sessionId);
    this.deps.permissionBroker.cleanupSession(sessionId, "Worker failed to start");
    this.deps.agentStatusRegistry.delete(sessionId);
    serviceLogger.warn(
      { sessionId, killed },
      "Cleaned up pending JSON session after startup failure",
    );
  }

  private createHostedPtySession(
    msg: Record<string, unknown>,
    cwd: string,
    provider: ProviderId,
    permissionMode?: string,
  ): void {
    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId: msg.requestId as string | undefined,
          sessionId: "",
          errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
          error: "Unsupported provider for PTY session.",
        }),
      );
      return;
    }

    const resumeSessionId = msg.resumeSessionId as string | undefined;
    const pendingId = nanoid();
    const name = tildify(cwd);
    const hook = this.deps.createHookContext(pendingId, provider);
    try {
      const pid = this.deps.hostedPtyRegistry.start({
        sessionId: pendingId,
        provider,
        cwd,
        args: buildHostedPtyArgs(provider, resumeSessionId),
        permissionMode,
        hook,
      });
      const session = this.deps.sessionManager.createSession(
        "pty",
        cwd,
        pid,
        name,
        pendingId,
        provider,
        "proxy-hosted",
      );
      if (resumeSessionId && provider === "claude") {
        this.deps.sessionManager.setClaudeSessionId(session.id, resumeSessionId);
      }
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId: msg.requestId as string | undefined,
          sessionId: session.id,
          mode: "pty",
          provider,
          ptyOwner: "proxy-hosted",
        }),
      );
      this.deps.controlHandlers.pushCommandList(session.id, cwd);
      this.deps.controlHandlers.pushFileTree(session.id, cwd);
      this.deps.broadcastSessionSync(session);
      this.deps.broadcastSessionList();
      serviceLogger.info({ sessionId: session.id, provider, cwd }, "Hosted PTY session created");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId: msg.requestId as string | undefined,
          sessionId: "",
          errorCode: ControlErrorCode.PROCESS_START_FAILED,
          error,
        }),
      );
      const providerEnv = this.deps.getProviderEnv();
      serviceLogger.warn(
        {
          provider,
          cwd,
          error,
          claudeBin: providerEnv.CLAUDE_BIN,
          codexBin: providerEnv.CODEX_BIN,
          path: providerEnv.PATH,
        },
        "Hosted PTY session create failed",
      );
    }
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
}
