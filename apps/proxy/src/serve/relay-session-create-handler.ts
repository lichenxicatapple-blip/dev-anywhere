import { rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { nanoid } from "nanoid";
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

interface RelaySessionCreateHandlerDeps {
  relaySend: RelaySend;
  workerRegistry: WorkerRegistry;
  sessionManager: SessionManager;
  hostedPtyRegistry: HostedPtyRegistry;
  controlHandlers: ControlMessageHandlers;
  permissionBroker: PermissionBroker;
  agentStatusRegistry: AgentStatusRegistry;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext;
  cleanupHookContext: (sessionId: string) => void;
  broadcastSessionSync: (session: SessionInfo) => void;
  broadcastSessionList: () => void;
}

function validateSessionCwd(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd.trim()) return "请输入工作目录";
  const trimmed = cwd.trim();
  if (!isAbsolute(trimmed)) return "工作目录必须是绝对路径";
  try {
    const stat = statSync(trimmed);
    return stat.isDirectory() ? null : "工作目录不是目录";
  } catch {
    return `工作目录不存在或不可访问: ${trimmed}`;
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
          error: cwdError,
        }),
      );
      serviceLogger.warn({ cwd }, "Session create rejected: invalid cwd");
      return;
    }
    const sessionCwd = typeof cwd === "string" ? cwd.trim() : "";

    const provider = msg.provider as ProviderId | undefined;
    const mode = (msg.mode as "json" | "pty" | undefined) ?? "json";
    if (mode === "pty") {
      this.createHostedPtySession(msg, sessionCwd, provider ?? "claude");
      return;
    }

    if (provider !== "claude") {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId,
          sessionId: "",
          error:
            provider === "codex"
              ? "Codex JSON sessions are not supported yet; start a Codex PTY session locally."
              : "Unsupported provider for JSON session.",
        }),
      );
      serviceLogger.warn({ provider }, "JSON session create rejected for unsupported provider");
      return;
    }

    const resumeSessionId = msg.resumeSessionId as string | undefined;
    const permissionMode = msg.permissionMode as string | undefined;
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
  ): void {
    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId: msg.requestId as string | undefined,
          sessionId: "",
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
      this.deps.relaySend(
        JSON.stringify({
          type: "session_create_response",
          requestId: msg.requestId as string | undefined,
          sessionId: "",
          error: String(err),
        }),
      );
      serviceLogger.warn({ provider, cwd, error: String(err) }, "Hosted PTY session create failed");
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
