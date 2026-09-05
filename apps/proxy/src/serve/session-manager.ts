import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { nanoid } from "nanoid";
import { defineFSM, SessionState } from "@dev-anywhere/shared";
import { atomicWriteFileSync } from "../common/atomic-write.js";
import { serviceLogger } from "../common/logger.js";
import {
  isManagedSessionProcess,
  type ManagedSessionProcessIdentity,
} from "../common/managed-session-process.js";
import { sessionPaths } from "../common/paths.js";
import {
  PersistedSessionRecordSchema,
  type PersistedSessionRecord,
} from "../common/persisted-session.js";
import type { ProviderId } from "../providers/index.js";
import { upsertSessionHistoryMetadata } from "./session-history-metadata.js";

interface SessionInfoCommon {
  id: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  name?: string;
  nameLocked?: boolean;
  cwd: string;
  // Claude CLI 自己生成的 session ID，和上面 id 字段无关
  // 用途：定位 ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl 历史文件 / 支持 --resume
  claudeSessionId?: string;
  // JSON 会话通过 --resume 启动时，Claude 可能立刻生成新的 session_id。
  // 被恢复的会话仍是初始历史的来源，不能被新 session_id 覆盖。
  historySessionId?: string;
  pid: number;
}

export type SessionInfo =
  | (SessionInfoCommon & {
      kind: "agent";
      mode: "json";
      provider: ProviderId;
      ptyOwner?: never;
    })
  | (SessionInfoCommon & {
      kind: "agent";
      mode: "pty";
      provider: ProviderId;
      ptyOwner: "local-terminal" | "proxy-hosted";
    })
  | (SessionInfoCommon & {
      kind: "terminal";
      mode: "pty";
      provider: "claude";
      ptyOwner: "proxy-hosted";
    });

type PtySessionClaimCommon = {
  cwd: string;
  pid: number;
  name?: string;
  sessionId?: string;
};

export type PtySessionClaim =
  | (PtySessionClaimCommon & {
      kind: "agent";
      provider: ProviderId;
      ptyOwner: "local-terminal" | "proxy-hosted";
    })
  | (PtySessionClaimCommon & {
      kind: "terminal";
      provider: "claude";
      ptyOwner: "proxy-hosted";
    });

export interface PtySessionClaimResult {
  session: SessionInfo;
  source: "created" | "active" | "pending";
}

type PersistedPtySessionRecord = Extract<PersistedSessionRecord, { mode: "pty" }>;

interface SessionManagerOptions {
  persistPath: string;
  allowSessionRuntimeHandover: { terminal: boolean; worker: boolean };
  historyMetadataPath?: string;
  reaperIntervalMs?: number;
  onSessionRemoved?: (id: string, context?: SessionRemoveContext) => void;
  isProcessAlive?: (pid: number) => boolean;
  isManagedSessionProcess?: (pid: number, identity: ManagedSessionProcessIdentity) => boolean;
  terminateManagedSession?: (pid: number) => void;
}

interface SessionRemoveContext {
  preserveProviderHooks?: boolean;
}

// 两个观察通道的合法转换表分离：PTY 看 OSC 信号、JSON 看 stream-json 事件，各自的状态空间和规则不同。
// terminated 是终态，不允许任何转出。

// PTY 观察通道：从终端 OSC 0/9 信号 + idle timer 推导状态。
// ERROR 在 PTY 观察通道不可达：PTY 错误体现为终端 ANSI 内容，proxy 不建模观察器失联。
const PTY_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  [SessionState.IDLE]: [
    // 用户提交输入或 provider 发出显式 working 信号 → PTY semantic 翻 working。
    // 原始 PTY 字节只负责输出转发，空闲期的终端重绘不能推动生命周期。
    SessionState.WORKING,
    // provider hook 是语义事件，可能比 PTY 字节观察更早到达；PermissionRequest 可直接进入审批等待。
    SessionState.WAITING_APPROVAL,
    // 终态兜底；现阶段 terminated 走 terminateSession 直接删 map 不经 updateState，本边未被触发
    SessionState.TERMINATED,
  ],
  [SessionState.COMPACTING]: [SessionState.TERMINATED],
  [SessionState.WORKING]: [
    // 5s 静默且 currentPtyState === "working" → idle timer 推 turn_complete
    SessionState.IDLE,
    // claude 发 OSC 9 "needs your permission: <tool>" → handlePtyData 推 approval_wait
    SessionState.WAITING_APPROVAL,
    // 终态兜底
    SessionState.TERMINATED,
  ],
  [SessionState.WAITING_APPROVAL]: [
    // 审批解除后 provider 可能继续工作，也可能直接结束本轮。
    // 真实 Claude 拒绝工具审批后会直接发 turn_complete，因此 WAITING_APPROVAL -> IDLE 是合法边。
    SessionState.WORKING,
    SessionState.IDLE,
    // 终态兜底
    SessionState.TERMINATED,
  ],
  // PTY 永不进入 ERROR；本行仅为满足 Record<SessionState,_> 枚举完整性保留
  [SessionState.ERROR]: [SessionState.TERMINATED],
  [SessionState.TERMINATED]: [],
};

// JSON 观察通道：从 stream-json 事件 + relay 入站消息推导状态。
// 注意：turn 结束时 result.is_error === true 不走 ERROR——它属于 turn 内部错误，观察通道本身健康，仍按 onTurnResult → IDLE 处理。
const JSON_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  [SessionState.IDLE]: [
    // 用户在 relay/web 端发消息 → onTurnStart，turn 开始
    SessionState.WORKING,
    // 原生 /compact 命令由 Claude CLI 处理，不是普通 assistant turn。
    SessionState.COMPACTING,
    // 空闲期观察通道失联（worker socket 死但 pid 仍在等）→ onChannelBroken
    SessionState.ERROR,
    // 终态兜底；同 PTY，当前不经 updateState
    SessionState.TERMINATED,
  ],
  [SessionState.WORKING]: [
    // stream-json result event → onTurnResult，turn 结束
    SessionState.IDLE,
    // claude 发 control_request → onApprovalRequested，阻塞等审批
    SessionState.WAITING_APPROVAL,
    // turn 进行中通道失联 → onChannelBroken
    SessionState.ERROR,
    // 终态兜底
    SessionState.TERMINATED,
  ],
  [SessionState.COMPACTING]: [
    // stream-json result event → /compact 结束回 IDLE
    SessionState.IDLE,
    // 压缩期间通道失联 → onChannelBroken
    SessionState.ERROR,
    // 终态兜底
    SessionState.TERMINATED,
  ],
  [SessionState.WAITING_APPROVAL]: [
    // 审批解除后 worker 已把 control_response 写回 CLI，agent 会继续执行工具/生成。
    // 即使 stream-json 后续只在 result event 才给出最终内容，UI 也必须立即退出等待审批态。
    SessionState.WORKING,
    SessionState.IDLE,
    // 审批死锁：control_response 写 worker stdin 失败 → onChannelBroken。
    // 这是 ERROR 态最明确的落地场景，让 UI 能区分 "正在等用户决定" 和 "审批通道坏了"。
    SessionState.ERROR,
    // 终态兜底
    SessionState.TERMINATED,
  ],
  [SessionState.ERROR]: [
    // 观察通道坏了之后只能 terminate，不回 IDLE/WORKING——恢复机制未实现
    SessionState.TERMINATED,
  ],
  [SessionState.TERMINATED]: [],
};

const ptyFSM = defineFSM(PTY_TRANSITIONS);
const jsonFSM = defineFSM(JSON_TRANSITIONS);

function fsmForMode(mode: "pty" | "json"): ReturnType<typeof defineFSM<SessionState>> {
  return mode === "pty" ? ptyFSM : jsonFSM;
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "claude" || value === "codex" || value === "kimi";
}

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private pendingPtyReconnectMetadata: Map<string, PersistedPtySessionRecord> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;
  private readonly historyMetadataPath?: string;
  private readonly reaperIntervalMs: number;
  private readonly onSessionRemoved?: (id: string, context?: SessionRemoveContext) => void;
  private readonly allowSessionRuntimeHandover: { terminal: boolean; worker: boolean };
  private readonly processAlive: (pid: number) => boolean;
  private readonly managedSessionProcess: (
    pid: number,
    identity: ManagedSessionProcessIdentity,
  ) => boolean;
  private readonly terminateManagedSession: (pid: number) => void;

  constructor(options: SessionManagerOptions) {
    this.persistPath = options.persistPath;
    this.historyMetadataPath = options.historyMetadataPath;
    this.reaperIntervalMs = options.reaperIntervalMs ?? 60000;
    this.onSessionRemoved = options.onSessionRemoved;
    this.allowSessionRuntimeHandover = options.allowSessionRuntimeHandover;
    this.processAlive =
      options.isProcessAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // Permission or inspection failures are not proof that the owner has exited.
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      });
    this.managedSessionProcess = options.isManagedSessionProcess ?? isManagedSessionProcess;
    this.terminateManagedSession =
      options.terminateManagedSession ?? ((pid) => process.kill(pid, "SIGTERM"));
    this.load();
  }

  createSession(
    kind: "agent",
    mode: "json",
    provider: ProviderId,
    cwd: string,
    pid: number,
    name?: string,
    id?: string,
    ptyOwner?: undefined,
    nameLocked?: boolean,
  ): SessionInfo;
  createSession(
    kind: "agent",
    mode: "pty",
    provider: ProviderId,
    cwd: string,
    pid: number,
    name: string | undefined,
    id: string | undefined,
    ptyOwner: "local-terminal" | "proxy-hosted",
    nameLocked?: boolean,
  ): SessionInfo;
  createSession(
    kind: "terminal",
    mode: "pty",
    provider: "claude",
    cwd: string,
    pid: number,
    name: string | undefined,
    id: string | undefined,
    ptyOwner: "proxy-hosted",
    nameLocked?: boolean,
  ): SessionInfo;
  createSession(
    kind: "agent" | "terminal",
    mode: "pty" | "json",
    provider: ProviderId,
    cwd: string,
    pid: number,
    name?: string,
    id?: string,
    ptyOwner?: "local-terminal" | "proxy-hosted",
    nameLocked?: boolean,
  ): SessionInfo {
    if (mode === "pty" && ptyOwner === undefined) {
      throw new TypeError("PTY session owner is required");
    }
    if (mode === "json" && ptyOwner !== undefined) {
      throw new TypeError("JSON session cannot have a PTY owner");
    }
    if (
      kind === "terminal" &&
      (mode !== "pty" || provider !== "claude" || ptyOwner !== "proxy-hosted")
    ) {
      throw new TypeError("Terminal sessions require a proxy-hosted Shell PTY");
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new TypeError("Session PID must be a positive safe integer");
    }
    if (cwd.length === 0) throw new TypeError("Session cwd cannot be empty");
    if (id !== undefined && id.length === 0) throw new TypeError("Session id cannot be empty");
    const now = Date.now();
    const pendingPtyMetadata =
      mode === "pty" && id !== undefined ? this.pendingPtyReconnectMetadata.get(id) : undefined;
    if (
      pendingPtyMetadata !== undefined &&
      (pendingPtyMetadata.kind !== kind ||
        pendingPtyMetadata.provider !== provider ||
        pendingPtyMetadata.ptyOwner !== ptyOwner ||
        pendingPtyMetadata.pid !== pid)
    ) {
      throw new TypeError("PTY reconnect identity does not match persisted session");
    }
    const resolvedName =
      pendingPtyMetadata?.nameLocked && pendingPtyMetadata.name !== undefined
        ? pendingPtyMetadata.name
        : (name ?? pendingPtyMetadata?.name);
    const resolvedNameLocked = pendingPtyMetadata?.nameLocked ?? (nameLocked ? true : undefined);
    const common: SessionInfoCommon = {
      id: id ?? nanoid(),
      state: SessionState.IDLE,
      createdAt: pendingPtyMetadata?.createdAt ?? now,
      updatedAt: pendingPtyMetadata?.updatedAt ?? now,
      cwd,
      pid,
      ...(resolvedName !== undefined ? { name: resolvedName } : {}),
      ...(resolvedNameLocked !== undefined ? { nameLocked: resolvedNameLocked } : {}),
      ...(pendingPtyMetadata?.claudeSessionId !== undefined
        ? { claudeSessionId: pendingPtyMetadata.claudeSessionId }
        : {}),
      ...(pendingPtyMetadata?.historySessionId !== undefined
        ? { historySessionId: pendingPtyMetadata.historySessionId }
        : {}),
    };
    let info: SessionInfo;
    if (kind === "terminal") {
      info = {
        ...common,
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
      };
    } else if (mode === "json") {
      info = { ...common, kind: "agent", mode: "json", provider };
    } else {
      if (ptyOwner === undefined) throw new TypeError("PTY session owner is required");
      info = {
        ...common,
        kind: "agent",
        mode: "pty",
        provider,
        ptyOwner,
      };
    }
    this.sessions.set(info.id, info);
    this.pendingPtyReconnectMetadata.delete(info.id);
    this.save();
    serviceLogger.info(
      { sessionId: info.id, kind: info.kind, mode, provider, ptyOwner, name },
      "Session created",
    );
    return info;
  }

  /**
   * Atomically creates or reclaims the PTY identity presented by an admitted IPC client.
   * A caller-supplied id is never a request to create arbitrary state: it must already be active
   * under the same process identity, or be an exact persisted handover waiting to reconnect.
   */
  claimPtySession(claim: PtySessionClaim): PtySessionClaimResult {
    const sessionId = claim.sessionId;
    if (sessionId === undefined) {
      return { session: this.createClaimedPtySession(claim), source: "created" };
    }

    const active = this.sessions.get(sessionId);
    if (active !== undefined) {
      this.assertPtyClaimIdentity(active, claim);
      if (active.cwd !== claim.cwd) {
        active.cwd = claim.cwd;
        this.save();
      }
      return { session: active, source: "active" };
    }

    const pending = this.pendingPtyReconnectMetadata.get(sessionId);
    if (pending === undefined) {
      throw new TypeError("PTY reconnect session is not available for handover");
    }
    this.assertPtyClaimIdentity(pending, claim);
    return { session: this.createClaimedPtySession(claim), source: "pending" };
  }

  /** Transport loss releases a binding, not the process or its persisted session identity. */
  releasePtyBinding(sessionId: string, expectedPid: number): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return this.pendingPtyReconnectMetadata.get(sessionId)?.pid === expectedPid;
    }
    if (session.mode !== "pty" || session.pid !== expectedPid) return false;
    const record = this.toPersistedRecord(session);
    if (record.mode !== "pty") return false;
    this.pendingPtyReconnectMetadata.set(sessionId, record);
    this.sessions.delete(sessionId);
    this.save();
    serviceLogger.info({ sessionId, pid: expectedPid }, "PTY binding released; awaiting reconnect");
    return true;
  }

  private createClaimedPtySession(claim: PtySessionClaim): SessionInfo {
    if (claim.kind === "terminal") {
      return this.createSession(
        "terminal",
        "pty",
        "claude",
        claim.cwd,
        claim.pid,
        claim.name,
        claim.sessionId,
        claim.ptyOwner,
      );
    }
    return this.createSession(
      "agent",
      "pty",
      claim.provider,
      claim.cwd,
      claim.pid,
      claim.name,
      claim.sessionId,
      claim.ptyOwner,
    );
  }

  private assertPtyClaimIdentity(
    session: SessionInfo | PersistedPtySessionRecord,
    claim: PtySessionClaim,
  ): void {
    if (
      session.kind !== claim.kind ||
      session.mode !== "pty" ||
      session.provider !== claim.provider ||
      session.ptyOwner !== claim.ptyOwner ||
      session.pid !== claim.pid
    ) {
      throw new TypeError("PTY reconnect identity does not match the session owner");
    }
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  getRuntimeSession(id: string): SessionInfo | PersistedPtySessionRecord | undefined {
    return this.sessions.get(id) ?? this.pendingPtyReconnectMetadata.get(id);
  }

  updateState(id: string, newState: SessionState): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      // session 不存在是调用方 bug，不是观察竞态，保留 throw
      throw new Error(`Session not found: ${id}`);
    }
    const oldState = session.state;
    if (oldState === newState) return false;
    const fsm = fsmForMode(session.mode);
    if (!fsm.canTransition(oldState, newState)) {
      // 吸收态之后的残余转换来自进程竞态，降噪到 debug；
      // 其他非法转换属于协议违反或 bug，保持 warn 可观测
      const level = fsm.isAbsorbing(oldState) ? "debug" : "warn";
      serviceLogger[level](
        { sessionId: id, from: oldState, to: newState, mode: session.mode },
        level === "debug"
          ? "State change after absorbing state (residual, likely race)"
          : "Invalid state transition rejected by FSM",
      );
      return false;
    }
    session.state = newState;
    session.updatedAt = Date.now();
    this.save();
    serviceLogger.info({ sessionId: id, from: oldState, to: newState }, "Session state changed");
    return true;
  }

  touchSession(id: string, now: number = Date.now(), minIntervalMs = 0): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (now - session.updatedAt < minIntervalMs) return false;
    session.updatedAt = now;
    this.save();
    return true;
  }

  terminateSession(id: string, context?: SessionRemoveContext): { success: boolean; pid?: number } {
    const session = this.sessions.get(id) ?? this.pendingPtyReconnectMetadata.get(id);
    if (!session) {
      return { success: false };
    }
    const pid = session.pid;
    this.sessions.delete(id);
    this.pendingPtyReconnectMetadata.delete(id);
    this.save();
    serviceLogger.info({ sessionId: id, mode: session.mode, pid }, "Session terminated");
    // 隔离 callback 异常: hook unregister / permission broker / 文件系统操作任意一步抛
    // 都不能让 terminateSession 把异常抛回调用方, 否则 socket close handler 上的后续
    // cleanupSessionResources + broadcastSessionList 会被吞掉, web 看到 session 残留。
    try {
      this.onSessionRemoved?.(id, context);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      serviceLogger.warn(
        {
          sessionId: id,
          err: { message: error.message, stack: error.stack, cause: error.cause },
        },
        "onSessionRemoved callback threw; session already removed from registry",
      );
    }
    return { success: true, pid };
  }

  terminateAll(): number[] {
    const pids: number[] = [];
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      const session = this.sessions.get(id)!;
      if (session.mode === "json" && session.pid !== undefined) {
        pids.push(session.pid);
      }
      this.sessions.delete(id);
      this.onSessionRemoved?.(id);
    }
    this.save();
    return pids;
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.claudeSessionId = claudeSessionId;
    this.save();
    this.recordRestoreMetadata(session, claudeSessionId);
  }

  setHistorySessionId(id: string, historySessionId: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.historySessionId = historySessionId;
    this.save();
    this.recordRestoreMetadata(session, historySessionId);
  }

  setPid(id: string, pid: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.pid = pid;
    this.save();
  }

  updateTerminalCwd(id: string, cwd: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.mode !== "pty" || session.kind !== "terminal") return false;

    const nextCwd = normalize(cwd);
    if (!isAbsolute(nextCwd) || nextCwd === session.cwd) return false;

    const previousCwd = session.cwd;
    session.cwd = nextCwd;
    session.updatedAt = Date.now();
    this.save();
    serviceLogger.info(
      { sessionId: id, previousCwd, cwd: nextCwd },
      "Terminal working directory changed",
    );
    return true;
  }

  renameSession(id: string, name: string): { success: boolean; name?: string; error?: string } {
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false, error: "Session not found" };
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: "Session title cannot be empty" };
    }
    session.name = trimmed;
    session.nameLocked = true;
    this.save();
    for (const nativeSessionId of new Set([session.claudeSessionId, session.historySessionId])) {
      if (nativeSessionId) this.recordRestoreMetadata(session, nativeSessionId);
    }
    serviceLogger.info({ sessionId: id }, "Session renamed");
    return { success: true, name: trimmed };
  }

  private recordRestoreMetadata(session: SessionInfo, nativeSessionId: string): void {
    upsertSessionHistoryMetadata(this.historyMetadataPath, {
      nativeSessionId,
      devAnywhereSessionId: session.id,
      provider: session.provider,
      mode: session.mode,
      cwd: session.cwd,
      ...(session.nameLocked === true && session.name !== undefined
        ? { title: session.name, nameLocked: true }
        : {}),
      updatedAt: Date.now(),
    });
  }

  startReaper(intervalMs: number = this.reaperIntervalMs): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = setInterval(() => this.reap(), intervalMs);
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  private reap(): void {
    const toRemove: Array<{ id: string; reason: string }> = [];
    // An absent IPC binding is not an exit. Keep disconnected PTYs until their owner is dead.
    for (const session of [
      ...this.sessions.values(),
      ...this.pendingPtyReconnectMetadata.values(),
    ]) {
      if (!this.isProcessAlive(session.pid)) {
        toRemove.push({ id: session.id, reason: `Session process ${session.pid} is dead` });
      }
    }
    for (const { id, reason } of toRemove) {
      serviceLogger.warn({ sessionId: id, reason }, "Reaping stale session");
      this.terminateSession(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    return this.processAlive(pid);
  }

  private save(): void {
    // state 是对 claude 的观察值，进程死后无意义，不落盘。磁盘上只留 identity（id/mode/cwd/pid/...）。
    const persisted = [
      ...Array.from(this.sessions.values()).map((s) => this.toPersistedRecord(s)),
      ...Array.from(this.pendingPtyReconnectMetadata.values()).map((s) =>
        this.toPersistedRecord(s),
      ),
    ];
    const data = JSON.stringify(persisted, null, 2);
    atomicWriteFileSync(this.persistPath, data, { ensureDir: true });
  }

  private toPersistedRecord(s: PersistedSessionRecord | SessionInfo): PersistedSessionRecord {
    const common = {
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      cwd: s.cwd,
      pid: s.pid,
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.nameLocked !== undefined ? { nameLocked: s.nameLocked } : {}),
      ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),
      ...(s.historySessionId !== undefined ? { historySessionId: s.historySessionId } : {}),
    };
    if (s.kind === "terminal") {
      return PersistedSessionRecordSchema.parse({
        ...common,
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
      });
    }
    if (s.mode === "pty") {
      return PersistedSessionRecordSchema.parse({
        ...common,
        kind: "agent",
        mode: "pty",
        provider: s.provider,
        ptyOwner: s.ptyOwner,
      });
    }
    return PersistedSessionRecordSchema.parse({
      ...common,
      kind: "agent",
      mode: "json",
      provider: s.provider,
    });
  }

  private discardManagedSessionProcess(item: unknown, reason: string): boolean {
    if (item === null || typeof item !== "object") return false;
    const candidate = item as {
      id?: unknown;
      kind?: unknown;
      mode?: unknown;
      provider?: unknown;
      ptyOwner?: unknown;
      pid?: unknown;
    };
    if (
      candidate.mode !== "json" &&
      !(
        candidate.mode === "pty" &&
        (candidate.ptyOwner === "local-terminal" || candidate.ptyOwner === "proxy-hosted")
      )
    ) {
      return false;
    }

    const sessionId = typeof candidate.id === "string" ? candidate.id : undefined;
    const pid = candidate.pid;
    let processAction: "not-running" | "terminated" | "unverified" | "signal-failed" =
      "not-running";
    if (
      sessionId !== undefined &&
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      this.isProcessAlive(pid)
    ) {
      const identity: ManagedSessionProcessIdentity = {
        id: sessionId,
        mode: candidate.mode,
        ...(candidate.kind === "agent" || candidate.kind === "terminal"
          ? { kind: candidate.kind }
          : {}),
        ...(isProviderId(candidate.provider) ? { provider: candidate.provider } : {}),
        ...(candidate.ptyOwner === "local-terminal" || candidate.ptyOwner === "proxy-hosted"
          ? { ptyOwner: candidate.ptyOwner }
          : {}),
        ...(candidate.mode === "json"
          ? { workerSocketPath: sessionPaths(sessionId).workerSock }
          : {}),
      };
      if (this.managedSessionProcess(pid, identity)) {
        try {
          this.terminateManagedSession(pid);
          processAction = "terminated";
        } catch (err) {
          processAction = "signal-failed";
          serviceLogger.warn(
            { sessionId, pid, error: String(err) },
            "Failed to stop managed session process",
          );
        }
      } else {
        processAction = "unverified";
      }
    }
    if (sessionId !== undefined) this.onSessionRemoved?.(sessionId);
    serviceLogger.warn({ sessionId, pid, mode: candidate.mode, processAction }, reason);
    return true;
  }

  private load(): void {
    if (!existsSync(this.persistPath)) {
      return;
    }
    const raw = readFileSync(this.persistPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 文件被截断 / 部分写入 / 手改成非法 JSON: 抛错会让 daemon 起不来, 用户没法 self-serve。
      // fail-soft 到空状态，避免单个损坏文件阻塞 daemon 启动。后续 reconnectAll 会拒绝并
      // 断开没有权威 session 记录的 worker，不会从无法校验的进程反向重建状态。
      serviceLogger.warn(
        { path: this.persistPath, error: String(err) },
        "Session persistence file unparseable, starting with empty state",
      );
      return;
    }
    if (!Array.isArray(parsed)) {
      serviceLogger.warn(
        { path: this.persistPath },
        "Session persistence file has unexpected format (not array), starting with empty state",
      );
      return;
    }
    for (const item of parsed) {
      // A daemon may only inherit managed session processes from the same IPC generation. Run
      // this against the raw record before strict field validation: a record from any other
      // generation may be incomplete yet still refer to a live process that would otherwise be
      // orphaned or keep retrying forever.
      const mode =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as { mode?: unknown }).mode
          : undefined;
      const allowHandover =
        mode === "json"
          ? this.allowSessionRuntimeHandover.worker
          : mode === "pty"
            ? this.allowSessionRuntimeHandover.terminal
            : false;
      if (!allowHandover) {
        const sessionId =
          item !== null &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : undefined;
        const managedProcessDiscarded = this.discardManagedSessionProcess(
          item,
          "Foreign-generation managed session process cleaned",
        );
        if (!managedProcessDiscarded) {
          if (sessionId !== undefined) this.onSessionRemoved?.(sessionId);
          serviceLogger.warn({ sessionId }, "Foreign-generation session record cleaned");
        }
        continue;
      }
      const parsedRecord = PersistedSessionRecordSchema.safeParse(item);
      if (!parsedRecord.success) {
        const sessionId =
          item !== null &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : undefined;
        const managedProcessDiscarded = this.discardManagedSessionProcess(
          item,
          "Invalid managed session record cleaned",
        );
        if (!managedProcessDiscarded && sessionId !== undefined) this.onSessionRemoved?.(sessionId);
        serviceLogger.warn(
          { sessionId, issues: parsedRecord.error.issues },
          "Session persistence record failed strict validation; cleaning session",
        );
        continue;
      }
      const info = parsedRecord.data;
      if (info.mode === "pty") {
        const processAlive = this.isProcessAlive(info.pid);
        if (processAlive) {
          // This only reserves metadata; it neither activates a session nor signals its PID.
          // The returning terminal must claim the exact persisted identity through IPC. An OS
          // command-line query is not needed here and its failure must not discard a live PTY.
          this.pendingPtyReconnectMetadata.set(info.id, info);
          serviceLogger.info(
            { sessionId: info.id, pid: info.pid },
            "PTY session skipped on load, terminal alive",
          );
        } else {
          // terminal 进程已死，清理数据
          this.onSessionRemoved?.(info.id);
          serviceLogger.info(
            { sessionId: info.id, pid: info.pid },
            "PTY session cleaned on load because its process is no longer alive",
          );
        }
        continue;
      }
      // JSON 会话：检查 worker 进程是否存活，无 PID 或进程已死则清理
      const processAlive = this.isProcessAlive(info.pid);
      const identityVerified =
        processAlive &&
        this.managedSessionProcess(info.pid, {
          id: info.id,
          mode: "json",
          provider: info.provider,
          workerSocketPath: sessionPaths(info.id).workerSock,
        });
      if (identityVerified) {
        // 加载回内存时 state 重置为 IDLE，等后续观察通道信号刷新
        this.sessions.set(info.id, { ...info, state: SessionState.IDLE });
      } else {
        this.onSessionRemoved?.(info.id);
        serviceLogger.info(
          { sessionId: info.id, pid: info.pid, processAlive, identityVerified },
          "JSON session cleaned on load because its process identity is unavailable",
        );
      }
    }
    // 清理后回写磁盘，避免已清理的会话在下次启动时重复处理
    this.save();
    if (this.sessions.size > 0) {
      serviceLogger.info({ count: this.sessions.size }, "Sessions restored from persistence");
    }
  }
}
