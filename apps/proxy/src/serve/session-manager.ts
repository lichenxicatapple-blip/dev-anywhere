import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { SessionState } from "@cc-anywhere/shared";
import { logger } from "../common/logger.js";

export interface SessionInfo {
  id: string;
  mode: "pty" | "json";
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  name?: string;
  cwd: string;
  claudeSessionId?: string;
  pid: number;
}

export interface SessionManagerOptions {
  persistPath: string;
  reaperIntervalMs?: number;
  onSessionRemoved?: (id: string) => void;
}

// 合法的状态转换表
// terminated 是终态，不允许任何转出
// error 只能转到 terminated
const VALID_TRANSITIONS: Record<SessionState, Set<SessionState>> = {
  [SessionState.IDLE]: new Set([
    SessionState.WORKING,
    SessionState.ERROR,
    SessionState.TERMINATED,
  ]),
  [SessionState.WORKING]: new Set([
    SessionState.IDLE,
    SessionState.WAITING_APPROVAL,
    SessionState.ERROR,
    SessionState.TERMINATED,
  ]),
  [SessionState.WAITING_APPROVAL]: new Set([
    SessionState.IDLE,
    SessionState.WORKING,
    SessionState.ERROR,
    SessionState.TERMINATED,
  ]),
  [SessionState.ERROR]: new Set([SessionState.TERMINATED]),
  [SessionState.TERMINATED]: new Set(),
};

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;
  private readonly reaperIntervalMs: number;
  private readonly onSessionRemoved?: (id: string) => void;

  constructor(options: SessionManagerOptions) {
    this.persistPath = options.persistPath;
    this.reaperIntervalMs = options.reaperIntervalMs ?? 60000;
    this.onSessionRemoved = options.onSessionRemoved;
    this.load();
  }

  createSession(mode: "pty" | "json", cwd: string, pid: number, name?: string, id?: string): SessionInfo {
    const now = Date.now();
    const info: SessionInfo = {
      id: id ?? nanoid(),
      mode,
      state: SessionState.IDLE,
      createdAt: now,
      updatedAt: now,
      cwd,
      pid,
      ...(name !== undefined ? { name } : {}),
    };
    this.sessions.set(info.id, info);
    this.save();
    logger.info({ sessionId: info.id, mode, name }, "Session created");
    return info;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  updateState(id: string, newState: SessionState): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    const allowed = VALID_TRANSITIONS[session.state];
    if (!allowed.has(newState)) {
      throw new Error(
        `Invalid state transition: ${session.state} -> ${newState}`,
      );
    }
    const oldState = session.state;
    session.state = newState;
    session.updatedAt = Date.now();
    this.save();
    logger.info({ sessionId: id, from: oldState, to: newState }, "Session state changed");
  }

  terminateSession(
    id: string,
  ): { success: boolean; pid?: number } {
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false };
    }
    const pid = session.pid;
    this.sessions.delete(id);
    this.save();
    logger.info({ sessionId: id, mode: session.mode, pid }, "Session terminated");
    this.onSessionRemoved?.(id);
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
      if (session.mode === "json" && session.pid !== undefined && session.state !== SessionState.TERMINATED) {
        if (!this.isProcessAlive(session.pid)) {
          toRemove.push({ id: session.id, reason: `JSON worker process ${session.pid} is dead` });
        }
      }
    }
    for (const { id, reason } of toRemove) {
      logger.warn({ sessionId: id, reason }, "Reaping stale session");
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
    const data = JSON.stringify(Array.from(this.sessions.values()), null, 2);
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
      throw new Error(
        `Failed to parse session persistence file at ${this.persistPath}`,
        { cause: err },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Session persistence file has invalid format at ${this.persistPath}: expected array`,
      );
    }
    for (const item of parsed) {
      const info = item as SessionInfo;
      if (info.updatedAt === undefined) {
        info.updatedAt = info.createdAt;
      }
      if (info.state === SessionState.TERMINATED) {
        this.onSessionRemoved?.(info.id);
        continue;
      }
      if (info.mode === "pty") {
        if (info.pid && this.isProcessAlive(info.pid)) {
          // terminal 进程仍存活，会重连，保留磁盘数据但不加载到内存
          logger.info({ sessionId: info.id, pid: info.pid }, "PTY session skipped on load, terminal alive");
        } else {
          // terminal 进程已死，清理数据
          this.onSessionRemoved?.(info.id);
          logger.info({ sessionId: info.id, pid: info.pid }, "PTY session cleaned on load, terminal dead");
        }
        continue;
      }
      // JSON 会话：检查 worker 进程是否存活，无 PID 或进程已死则清理
      if (info.pid && this.isProcessAlive(info.pid)) {
        if (info.state === SessionState.WAITING_APPROVAL) {
          info.state = SessionState.IDLE;
          logger.info({ sessionId: info.id }, "Reset WAITING_APPROVAL to IDLE on load");
        }
        this.sessions.set(info.id, info);
      } else {
        this.onSessionRemoved?.(info.id);
        logger.info({ sessionId: info.id, pid: info.pid }, "JSON session cleaned on load, worker dead");
      }
    }
    // 清理后回写磁盘，避免已清理的会话在下次启动时重复处理
    this.save();
    if (this.sessions.size > 0) {
      logger.info({ count: this.sessions.size }, "Sessions restored from persistence");
    }
  }
}
