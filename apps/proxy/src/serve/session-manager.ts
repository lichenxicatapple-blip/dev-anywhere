import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { SessionState } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { defineFSM } from "../common/state-machine.js";
import type { ProviderId } from "../providers/index.js";

export interface SessionInfo {
  id: string;
  mode: "pty" | "json";
  provider: ProviderId;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  name?: string;
  cwd: string;
  // Claude CLI 自己生成的 session ID，和上面 id 字段无关
  // 用途：定位 ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl 历史文件 / 支持 --resume
  claudeSessionId?: string;
  pid: number;
}

interface SessionManagerOptions {
  persistPath: string;
  reaperIntervalMs?: number;
  onSessionRemoved?: (id: string, context?: SessionRemoveContext) => void;
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
    // claude 开始响应用户输入 → handlePtyData 首字节翻 working
    SessionState.WORKING,
    // provider hook 是语义事件，可能比 PTY 字节观察更早到达；PermissionRequest 可直接进入审批等待。
    SessionState.WAITING_APPROVAL,
    // 终态兜底；现阶段 terminated 走 terminateSession 直接删 map 不经 updateState，本边未被触发
    SessionState.TERMINATED,
  ],
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
  [SessionState.WAITING_APPROVAL]: [
    // 粒度丢失：审批解除后 claude 继续跑，proxy 观察不到中间的 WORKING 信号，
    // 直到 result event 才感知 → onTurnResult 一次性从 WAITING_APPROVAL 跳到 IDLE。
    // 因此不列 WAITING_APPROVAL → WORKING 这条边。
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
  return value === "claude" || value === "codex";
}

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;
  private readonly reaperIntervalMs: number;
  private readonly onSessionRemoved?: (id: string, context?: SessionRemoveContext) => void;

  constructor(options: SessionManagerOptions) {
    this.persistPath = options.persistPath;
    this.reaperIntervalMs = options.reaperIntervalMs ?? 60000;
    this.onSessionRemoved = options.onSessionRemoved;
    this.load();
  }

  createSession(
    mode: "pty" | "json",
    cwd: string,
    pid: number,
    name?: string,
    id?: string,
    provider: ProviderId = "claude",
    ptyOwner?: "local-terminal" | "proxy-hosted",
  ): SessionInfo {
    const now = Date.now();
    const info: SessionInfo = {
      id: id ?? nanoid(),
      mode,
      provider,
      ...(mode === "pty" && ptyOwner !== undefined ? { ptyOwner } : {}),
      state: SessionState.IDLE,
      createdAt: now,
      updatedAt: now,
      cwd,
      pid,
      ...(name !== undefined ? { name } : {}),
    };
    this.sessions.set(info.id, info);
    this.save();
    serviceLogger.info({ sessionId: info.id, mode, provider, ptyOwner, name }, "Session created");
    return info;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
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
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false };
    }
    const pid = session.pid;
    this.sessions.delete(id);
    this.save();
    serviceLogger.info({ sessionId: id, mode: session.mode, pid }, "Session terminated");
    this.onSessionRemoved?.(id, context);
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
  }

  setPid(id: string, pid: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.pid = pid;
    this.save();
  }

  startReaper(intervalMs: number = this.reaperIntervalMs): void {
    this.stopReaper();
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
    // 检查 JSON 会话的子进程是否存活
    // PTY 会话的生命周期由 IPC socket close 事件管理，不需要 reaper 参与
    for (const session of this.sessions.values()) {
      if (
        session.mode === "json" &&
        session.pid !== undefined &&
        session.state !== SessionState.TERMINATED
      ) {
        if (!this.isProcessAlive(session.pid)) {
          toRemove.push({ id: session.id, reason: `JSON worker process ${session.pid} is dead` });
        }
      }
    }
    for (const { id, reason } of toRemove) {
      serviceLogger.warn({ sessionId: id, reason }, "Reaping stale session");
      this.terminateSession(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    const dir = dirname(this.persistPath);
    mkdirSync(dir, { recursive: true });
    // state 是对 claude 的观察值，进程死后无意义，不落盘。磁盘上只留 identity（id/mode/cwd/pid/...）。
    const persisted = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      mode: s.mode,
      provider: s.provider,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      cwd: s.cwd,
      pid: s.pid,
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),
    }));
    const data = JSON.stringify(persisted, null, 2);
    const tmpPath = this.persistPath + ".tmp";
    writeFileSync(tmpPath, data, "utf-8");
    renameSync(tmpPath, this.persistPath);
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
      throw new Error(`Failed to parse session persistence file at ${this.persistPath}`, {
        cause: err,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Session persistence file has invalid format at ${this.persistPath}: expected array`,
      );
    }
    for (const item of parsed) {
      if (item && typeof item === "object" && "state" in item) {
        throw new Error(
          `Session persistence file has invalid persisted state for session ${String(
            (item as { id?: unknown }).id,
          )}`,
        );
      }
      const info = item as Omit<SessionInfo, "state"> & { state?: SessionState };
      if (!isProviderId(info.provider)) {
        const sessionId = String(info.id);
        this.onSessionRemoved?.(sessionId);
        serviceLogger.warn(
          { sessionId, provider: info.provider },
          "Session persistence file has invalid provider; cleaning session",
        );
        continue;
      }
      if (info.mode === "pty") {
        if (info.pid && this.isProcessAlive(info.pid)) {
          // terminal 进程仍存活，会重连，保留磁盘数据但不加载到内存
          serviceLogger.info(
            { sessionId: info.id, pid: info.pid },
            "PTY session skipped on load, terminal alive",
          );
        } else {
          // terminal 进程已死，清理数据
          this.onSessionRemoved?.(info.id);
          serviceLogger.info(
            { sessionId: info.id, pid: info.pid },
            "PTY session cleaned on load, terminal dead",
          );
        }
        continue;
      }
      // JSON 会话：检查 worker 进程是否存活，无 PID 或进程已死则清理
      if (info.pid && this.isProcessAlive(info.pid)) {
        // 加载回内存时 state 重置为 IDLE，等后续观察通道信号刷新
        this.sessions.set(info.id, { ...info, state: SessionState.IDLE });
      } else {
        this.onSessionRemoved?.(info.id);
        serviceLogger.info(
          { sessionId: info.id, pid: info.pid },
          "JSON session cleaned on load, worker dead",
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
