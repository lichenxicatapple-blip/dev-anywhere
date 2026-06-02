import { rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { nanoid } from "nanoid";
import { ControlErrorCode, serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { sessionPaths, tildify } from "../common/paths.js";
import type { ProviderHookContext, ProviderId } from "../providers/index.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import { buildHostedPtyArgs, type HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import { readSessionMessagesPage } from "./session-history.js";
import type { TerminalWorkerSpawner } from "./terminal-worker-spawner.js";
import type { WorkerRegistry } from "./worker-registry.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import { classifyPathError } from "./path-errors.js";

const JSON_WORKER_READY_TIMEOUT_MS = 15_000;

interface RelaySessionCreateHandlerDeps {
  relaySend: RelaySend;
  workerRegistry: WorkerRegistry;
  sessionManager: SessionManager;
  hostedPtyRegistry: HostedPtyRegistry;
  terminalWorkerSpawner: TerminalWorkerSpawner;
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

function normalizeSessionName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveTerminalCwd(): string {
  const home = homedir();
  if (home) {
    try {
      if (statSync(home).isDirectory()) return home;
    } catch {
      // fall through to process.cwd()
    }
  }
  return process.cwd();
}

export class RelaySessionCreateHandler {
  // 跟踪每个 pendingId 当前挂起的 retry timer。SIGTERM 抵达时 destroy() 会 clear
  // 这些 timer 并执行 cleanupPendingJsonSession，否则 worker 子进程在窗口期内可能成为孤儿
  // （setTimeout 回调命中时 workerRegistry 已经 destroyAll，但 worker 进程并未被 kill）。
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: RelaySessionCreateHandlerDeps) {}

  destroy(): void {
    for (const [pendingId, timer] of this.pendingTimers) {
      clearTimeout(timer);
      this.cleanupPendingJsonSession(pendingId);
    }
    this.pendingTimers.clear();
  }

  onSessionCreate(msg: ControlMessage<"session_create">): void {
    if (msg.kind === "terminal") {
      this.createShellTerminalSession(msg);
      return;
    }

    const { requestId, cwd } = msg;
    const cwdError = validateSessionCwd(cwd);
    if (cwdError) {
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId,
          error: cwdError.message,
          errorCode: cwdError.code,
        }),
      );
      serviceLogger.warn({ cwd }, "Session create rejected: invalid cwd");
      return;
    }
    const sessionCwd = typeof cwd === "string" ? cwd.trim() : "";

    const provider = msg.provider ?? "claude";
    const mode = msg.mode ?? "json";
    const permissionMode = msg.permissionMode;
    if (mode === "pty") {
      this.createHostedPtySession(msg, sessionCwd, provider ?? "claude", permissionMode);
      return;
    }

    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId,
          errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
          error: "Unsupported provider for JSON session.",
        }),
      );
      serviceLogger.warn({ provider }, "JSON session create rejected for unsupported provider");
      return;
    }

    const resumeSessionId = msg.resumeSessionId;
    // streamDelta 不在 session_create 协议字段里：当前没有客户端发起 delta 模式，
    // 默认关闭即可。后续若要恢复增量推送，需先在 RelayControlSchema 加字段。
    const streamDelta = false;
    const requestedName = normalizeSessionName(msg.name);
    const name = requestedName ?? tildify(sessionCwd);
    const nameLocked = requestedName !== undefined;
    const pendingId = nanoid();
    const hook = this.deps.createHookContext(pendingId, provider);
    const workerPid = this.deps.workerRegistry.spawn(pendingId, {
      cwd: sessionCwd,
      resumeSessionId,
      permissionMode,
      provider,
      streamDelta,
      hook,
    });

    const paths = sessionPaths(pendingId);
    let attempt = 0;
    const maxRetries = 20;
    const scheduleAttempt = (delayMs: number): void => {
      const timer = setTimeout(tryConnect, delayMs);
      this.pendingTimers.set(pendingId, timer);
    };
    const tryConnect = () => {
      this.pendingTimers.delete(pendingId);
      attempt++;
      this.deps.workerRegistry.connect(pendingId, paths.workerSock).then((sock) => {
        if (sock) {
          this.deps.workerRegistry
            .waitForReady(pendingId, JSON_WORKER_READY_TIMEOUT_MS)
            .then(() => {
              const session = this.deps.sessionManager.createSession(
                "json",
                sessionCwd,
                workerPid,
                name,
                pendingId,
                provider,
                undefined,
                nameLocked,
              );
              if (resumeSessionId) {
                this.deps.sessionManager.setHistorySessionId(session.id, resumeSessionId);
              }
              this.deps.relaySend(
                serializeControl({
                  type: "session_create_response",
                  requestId,
                  sessionId: session.id,
                  name: session.name,
                  nameLocked: session.nameLocked,
                  mode: "json",
                  provider,
                }),
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
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err.message : String(err);
              this.cleanupPendingJsonSession(pendingId);
              this.deps.relaySend(
                serializeControl({
                  type: "session_create_response",
                  requestId,
                  sessionId: pendingId,
                  errorCode: ControlErrorCode.WORKER_START_FAILED,
                  error,
                }),
              );
              serviceLogger.error(
                { sessionId: pendingId, error },
                "Worker failed to report ready via relay",
              );
            });
        } else if (attempt < maxRetries) {
          scheduleAttempt(Math.min(100 * attempt, 2000));
        } else {
          this.cleanupPendingJsonSession(pendingId);
          this.deps.relaySend(
            serializeControl({
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
    scheduleAttempt(100);
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
    msg: ControlMessage<"session_create">,
    cwd: string,
    provider: ProviderId,
    permissionMode?: string,
  ): void {
    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId: msg.requestId,
          errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
          error: "Unsupported provider for PTY session.",
        }),
      );
      return;
    }

    const resumeSessionId = msg.resumeSessionId;
    const pendingId = nanoid();
    const requestedName = normalizeSessionName(msg.name);
    const name = requestedName ?? tildify(cwd);
    const nameLocked = requestedName !== undefined;
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
        nameLocked,
      );
      if (resumeSessionId) {
        if (provider === "claude") {
          this.deps.sessionManager.setClaudeSessionId(session.id, resumeSessionId);
        } else {
          this.deps.sessionManager.setHistorySessionId(session.id, resumeSessionId);
        }
      }
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId: msg.requestId,
          sessionId: session.id,
          name: session.name,
          nameLocked: session.nameLocked,
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
        serializeControl({
          type: "session_create_response",
          requestId: msg.requestId,
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

  private createShellTerminalSession(msg: ControlMessage<"session_create">): void {
    const pendingId = nanoid();
    const cwd = resolveTerminalCwd();
    const requestedName = normalizeSessionName(msg.name);
    const name = requestedName ?? "终端 · ~";
    const nameLocked = requestedName !== undefined;

    try {
      const pid = this.deps.terminalWorkerSpawner.start({
        sessionId: pendingId,
        cwd,
        name,
      });
      const session = this.deps.sessionManager.createSession(
        "pty",
        cwd,
        pid,
        name,
        pendingId,
        "claude",
        "local-terminal",
        nameLocked,
        "terminal",
      );
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId: msg.requestId,
          sessionId: session.id,
          name: session.name,
          nameLocked: session.nameLocked,
          kind: "terminal",
          mode: "pty",
          provider: session.provider,
          ptyOwner: "local-terminal",
        }),
      );
      this.deps.broadcastSessionSync(session);
      this.deps.broadcastSessionList();
      serviceLogger.info({ sessionId: session.id, cwd }, "Shell terminal session created");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.relaySend(
        serializeControl({
          type: "session_create_response",
          requestId: msg.requestId,
          errorCode: ControlErrorCode.PROCESS_START_FAILED,
          error,
        }),
      );
      serviceLogger.warn({ cwd, error }, "Shell terminal session create failed");
    }
  }

  private pushHistoryMessages(sessionId: string, resumeSessionId: string): void {
    const provider = this.deps.sessionManager.getSession(sessionId)?.provider;
    readSessionMessagesPage(resumeSessionId, undefined, provider)
      .then((page) => {
        if (page.messages.length === 0) return;
        this.deps.relaySend(
          serializeControl({
            type: "session_history_messages",
            sessionId,
            messages: page.messages,
            hasMore: page.hasMore,
            ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
          }),
        );
        serviceLogger.info(
          {
            sessionId,
            resumeSessionId,
            messageCount: page.messages.length,
            hasMore: page.hasMore,
          },
          "History message page sent for resumed session",
        );
      })
      .catch((err) => {
        serviceLogger.warn(
          { sessionId, error: String(err) },
          "Failed to read session history page",
        );
      });
  }
}
