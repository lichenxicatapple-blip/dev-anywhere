import { rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { nanoid } from "nanoid";
import {
  ControlErrorCode,
  PTY_INITIAL_MAX_COLS,
  PTY_INITIAL_MAX_ROWS,
  PTY_INITIAL_MIN_COLS,
  PTY_INITIAL_MIN_ROWS,
  SESSION_CREATE_SERVER_DEADLINE_MS,
  serializeControl,
  type ControlMessage,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { sessionPaths, tildify } from "../common/paths.js";
import { findCodexActiveWriter, type CodexActiveWriter } from "../common/codex-active-writer.js";
import {
  codexActiveWriterMessage,
  sanitizeProviderErrorTail,
} from "../common/codex-session-conflict.js";
import { findClosestAncestorPid } from "../common/process-ancestry.js";
import type { ProviderHookContext, ProviderId } from "../providers/index.js";
import {
  CodexApprovalPolicyUnsupportedError,
  resolveCodexPermissionPolicy,
} from "../providers/codex.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import { buildHostedPtyArgs, type HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import { readSessionMessagesPage } from "./session-history.js";
import type { TerminalWorkerSpawner } from "./terminal-worker-spawner.js";
import { WorkerStartupError, type WorkerRegistry } from "./worker-registry.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import { classifyPathError } from "./path-errors.js";
import { JsonWorkerStartupTimeoutError, waitForJsonWorkerStartup } from "./json-worker-startup.js";

const WORKER_START_FAILED_MESSAGE = "Agent 进程启动失败，请检查 Agent CLI 配置后重试";
const WORKER_START_TIMEOUT_MESSAGE = "Agent 启动超时，请检查 Agent CLI 配置与开发机负载后重试";

interface PendingJsonCreate {
  controller: AbortController;
}

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
  findCodexActiveWriter?: (threadId: string, env?: NodeJS.ProcessEnv) => CodexActiveWriter | null;
  findClosestAncestorPid?: (processPid: number, candidatePids: readonly number[]) => number | null;
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

export function resolveInitialPtyGeometry(input: { cols?: number; rows?: number }): {
  cols: number;
  rows: number;
} {
  const normalize = (value: number | undefined, min: number, max: number): number => {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.trunc(value ?? min)));
  };
  return {
    cols: normalize(input.cols, PTY_INITIAL_MIN_COLS, PTY_INITIAL_MAX_COLS),
    rows: normalize(input.rows, PTY_INITIAL_MIN_ROWS, PTY_INITIAL_MAX_ROWS),
  };
}

export class RelaySessionCreateHandler {
  // spawn/connect/ready 共享一个绝对截止时间。pending 在 publish 前不进入
  // SessionManager，所以失败或 shutdown 都可以作为一个未发布事务统一回收。
  private readonly pendingJsonCreates = new Map<string, PendingJsonCreate>();

  constructor(private readonly deps: RelaySessionCreateHandlerDeps) {}

  destroy(): void {
    for (const [pendingId, pending] of this.pendingJsonCreates) {
      this.pendingJsonCreates.delete(pendingId);
      pending.controller.abort(new Error("Relay session create handler destroyed"));
      this.cleanupPendingJsonSession(pendingId);
    }
  }

  onSessionCreate(msg: ControlMessage<"session_create">): void {
    if (msg.kind === "terminal") {
      this.createShellTerminalSession(msg);
      return;
    }

    const { requestId, cwd } = msg;
    const provider = msg.provider ?? "claude";
    const mode = msg.mode ?? "json";
    const permissionMode = msg.permissionMode;
    const resumeSessionId = msg.resumeSessionId;

    if (provider === "codex") {
      if (resumeSessionId) {
        const managedSessions = this.deps.sessionManager.listSessions();
        const existing = managedSessions.find(
          (session) => session.provider === "codex" && session.historySessionId === resumeSessionId,
        );
        if (existing) {
          this.respondWithExistingSession(requestId, existing);
          return;
        }

        const activeWriter = (this.deps.findCodexActiveWriter ?? findCodexActiveWriter)(
          resumeSessionId,
          this.deps.getProviderEnv(),
        );
        if (activeWriter) {
          // 本地 `dev-anywhere codex resume` 的历史选择发生在 Codex TUI 内，旧版本没有
          // 回传所选 thread ID。用真实 writer PID 的父进程链确认归属，仍能无提示复用
          // 当前 DEV Anywhere 会话；只有不属于任何登记会话时才视为外部占用。
          const managedOwnerPid = (this.deps.findClosestAncestorPid ?? findClosestAncestorPid)(
            activeWriter.pid,
            managedSessions.map((session) => session.pid),
          );
          const managedOwner =
            managedOwnerPid === null
              ? undefined
              : managedSessions.find((session) => session.pid === managedOwnerPid);
          if (managedOwner) {
            this.respondWithExistingSession(requestId, managedOwner);
            return;
          }

          this.deps.relaySend(
            serializeControl({
              type: "session_create_response",
              requestId,
              errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
              error: codexActiveWriterMessage(activeWriter.pid),
              activeWriterPid: activeWriter.pid,
            }),
          );
          serviceLogger.warn(
            { provider, nativeSessionId: resumeSessionId, pid: activeWriter.pid },
            "Codex resume rejected: native session already has an active writer",
          );
          return;
        }
      }

      try {
        resolveCodexPermissionPolicy(permissionMode);
      } catch (err) {
        if (!(err instanceof CodexApprovalPolicyUnsupportedError)) throw err;
        this.deps.relaySend(
          serializeControl({
            type: "session_create_response",
            requestId,
            errorCode: ControlErrorCode.APPROVAL_POLICY_UNSUPPORTED,
            error: err.message,
          }),
        );
        serviceLogger.warn(
          { provider, permissionMode },
          "Codex session create rejected: unsupported approval policy",
        );
        return;
      }
    }

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

    // Proxy 把 provider delta 聚合为版本化全文快照。Claude 开启 partial stream 后，
    // 刷新或重连才能恢复生成到当前时刻的完整内容。
    const streamDelta = true;
    const requestedName = normalizeSessionName(msg.name);
    const name = requestedName ?? tildify(sessionCwd);
    const nameLocked = requestedName !== undefined;
    const pendingId = nanoid();
    const deadlineAt = Date.now() + SESSION_CREATE_SERVER_DEADLINE_MS;
    let workerPid: number;
    try {
      const hook = this.deps.createHookContext(pendingId, provider);
      workerPid = this.deps.workerRegistry.spawn(pendingId, {
        cwd: sessionCwd,
        resumeSessionId,
        permissionMode,
        provider,
        streamDelta,
        hook,
      });
    } catch (err) {
      this.reportJsonStartupFailure(requestId, pendingId, WORKER_START_FAILED_MESSAGE, err);
      return;
    }

    const controller = new AbortController();
    this.pendingJsonCreates.set(pendingId, { controller });
    void waitForJsonWorkerStartup({
      workerRegistry: this.deps.workerRegistry,
      sessionId: pendingId,
      socketPath: sessionPaths(pendingId).workerSock,
      deadlineAt,
      signal: controller.signal,
    })
      .then(() =>
        this.publishJsonSession({
          requestId,
          pendingId,
          workerPid,
          sessionCwd,
          name,
          nameLocked,
          provider,
          resumeSessionId,
        }),
      )
      .catch((err: unknown) => {
        if (!this.takePendingJsonCreate(pendingId)) return;
        this.reportJsonStartupFailure(
          requestId,
          pendingId,
          err instanceof JsonWorkerStartupTimeoutError
            ? WORKER_START_TIMEOUT_MESSAGE
            : WORKER_START_FAILED_MESSAGE,
          err,
        );
      });
  }

  private respondWithExistingSession(requestId: string | undefined, session: SessionInfo): void {
    this.deps.relaySend(
      serializeControl({
        type: "session_create_response",
        requestId,
        sessionId: session.id,
        ...(session.kind !== undefined ? { kind: session.kind } : {}),
        ...(session.name !== undefined ? { name: session.name } : {}),
        ...(session.nameLocked !== undefined ? { nameLocked: session.nameLocked } : {}),
        mode: session.mode,
        provider: session.provider,
        ...(session.ptyOwner !== undefined ? { ptyOwner: session.ptyOwner } : {}),
      }),
    );
    serviceLogger.info(
      { sessionId: session.id, nativeSessionId: session.historySessionId },
      "Codex resume reused an existing DEV Anywhere session",
    );
  }

  private takePendingJsonCreate(sessionId: string): boolean {
    if (!this.pendingJsonCreates.has(sessionId)) return false;
    this.pendingJsonCreates.delete(sessionId);
    return true;
  }

  private publishJsonSession(options: {
    requestId?: string;
    pendingId: string;
    workerPid: number;
    sessionCwd: string;
    name: string;
    nameLocked: boolean;
    provider: ProviderId;
    resumeSessionId?: string;
  }): void {
    if (!this.takePendingJsonCreate(options.pendingId)) return;
    let session: SessionInfo;
    try {
      session = this.deps.sessionManager.createSession(
        "json",
        options.sessionCwd,
        options.workerPid,
        options.name,
        options.pendingId,
        options.provider,
        undefined,
        options.nameLocked,
      );
    } catch (err) {
      this.reportJsonStartupFailure(
        options.requestId,
        options.pendingId,
        WORKER_START_FAILED_MESSAGE,
        err,
      );
      return;
    }
    const nativeSession = this.deps.workerRegistry.takePendingNativeSession(session.id);
    if (nativeSession) {
      if (nativeSession.provider === "claude") {
        this.deps.sessionManager.setClaudeSessionId(session.id, nativeSession.sessionId);
      } else {
        this.deps.sessionManager.setHistorySessionId(session.id, nativeSession.sessionId);
      }
    }
    if (options.resumeSessionId) {
      this.deps.sessionManager.setHistorySessionId(session.id, options.resumeSessionId);
    }
    this.deps.relaySend(
      serializeControl({
        type: "session_create_response",
        requestId: options.requestId,
        sessionId: session.id,
        name: session.name,
        nameLocked: session.nameLocked,
        mode: "json",
        provider: options.provider,
      }),
    );
    if (options.resumeSessionId) {
      this.pushHistoryMessages(session.id, options.resumeSessionId);
    }
    serviceLogger.info(
      { sessionId: session.id, cwd: options.sessionCwd },
      "JSON session created via relay",
    );
    this.deps.controlHandlers.pushCommandList(session.id, options.sessionCwd);
    this.deps.broadcastSessionSync(session);
    this.deps.broadcastSessionList();
  }

  private reportJsonStartupFailure(
    requestId: string | undefined,
    sessionId: string,
    message: string,
    reason: unknown,
  ): void {
    this.cleanupPendingJsonSession(sessionId);
    const reasonText = reason instanceof Error ? reason.message : String(reason);
    const startupErrorTail = sanitizeProviderErrorTail(reasonText);
    const activeWriterFailure =
      reason instanceof WorkerStartupError &&
      reason.errorCode === ControlErrorCode.SESSION_ALREADY_ACTIVE
        ? reason
        : null;
    const activeWriter = activeWriterFailure?.nativeSessionId
      ? (this.deps.findCodexActiveWriter ?? findCodexActiveWriter)(
          activeWriterFailure.nativeSessionId,
          this.deps.getProviderEnv(),
        )
      : null;
    this.deps.relaySend(
      serializeControl({
        type: "session_create_response",
        requestId,
        sessionId,
        errorCode: activeWriterFailure
          ? ControlErrorCode.SESSION_ALREADY_ACTIVE
          : ControlErrorCode.WORKER_START_FAILED,
        error: activeWriterFailure ? codexActiveWriterMessage(activeWriter?.pid) : message,
        ...(activeWriter ? { activeWriterPid: activeWriter.pid } : {}),
      }),
    );
    serviceLogger.error(
      {
        sessionId,
        ...(startupErrorTail ? { startupErrorTail } : {}),
        errorCode: activeWriterFailure?.errorCode,
        timedOut: message === WORKER_START_TIMEOUT_MESSAGE,
      },
      "JSON worker startup failed via relay",
    );
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
    const geometry = resolveInitialPtyGeometry(msg);
    let session: SessionInfo;
    try {
      const hook = this.deps.createHookContext(pendingId, provider);
      const pid = this.deps.hostedPtyRegistry.start({
        sessionId: pendingId,
        provider,
        cwd,
        args: buildHostedPtyArgs(provider, resumeSessionId),
        permissionMode,
        nativeSessionId: resumeSessionId,
        hook,
        ...geometry,
      });
      session = this.deps.sessionManager.createSession(
        "pty",
        cwd,
        pid,
        name,
        pendingId,
        provider,
        "proxy-hosted",
        nameLocked,
      );
    } catch (err) {
      this.cleanupPendingHostedPtySession(pendingId);
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
      return;
    }

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
  }

  private cleanupPendingHostedPtySession(sessionId: string): void {
    const killed = this.deps.hostedPtyRegistry.abortStartup(sessionId);
    rmSync(sessionPaths(sessionId).dir, { recursive: true, force: true });
    this.deps.cleanupHookContext(sessionId);
    this.deps.permissionBroker.cleanupSession(sessionId, "Hosted PTY failed to start");
    this.deps.agentStatusRegistry.delete(sessionId);
    serviceLogger.warn(
      { sessionId, killed },
      "Cleaned up pending hosted PTY session after startup failure",
    );
  }

  private createShellTerminalSession(msg: ControlMessage<"session_create">): void {
    const pendingId = nanoid();
    const cwd = resolveTerminalCwd();
    const requestedName = normalizeSessionName(msg.name);
    const name = requestedName ?? tildify(cwd);
    const nameLocked = requestedName !== undefined;
    const geometry = resolveInitialPtyGeometry(msg);

    try {
      const pid = this.deps.terminalWorkerSpawner.start({
        sessionId: pendingId,
        cwd,
        name,
        ...geometry,
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
