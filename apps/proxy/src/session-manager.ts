import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { SessionState } from "@cc-anywhere/shared";

export interface SessionInfo {
  id: string;
  mode: "pty" | "json";
  state: SessionState;
  createdAt: number;
  name?: string;
  claudeSessionId?: string;
  pid?: number;
  lastHeartbeat?: number;
}

export interface SessionManagerOptions {
  persistPath: string;
  reaperIntervalMs?: number;
  heartbeatTimeoutMs?: number;
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
  private readonly heartbeatTimeoutMs: number;

  constructor(options: SessionManagerOptions) {
    this.persistPath = options.persistPath;
    this.reaperIntervalMs = options.reaperIntervalMs ?? 30000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30000;
    this.load();
  }

  createSession(mode: "pty" | "json", name?: string): SessionInfo {
    const info: SessionInfo = {
      id: nanoid(),
      mode,
      state: SessionState.IDLE,
      createdAt: Date.now(),
      ...(name !== undefined ? { name } : {}),
    };
    this.sessions.set(info.id, info);
    this.save();
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
    session.state = newState;
    this.save();
  }

  terminateSession(
    id: string,
  ): { success: boolean; pid?: number } {
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false };
    }
    if (session.state === SessionState.TERMINATED) {
      return { success: true, pid: session.pid };
    }
    this.updateState(id, SessionState.TERMINATED);
    return { success: true, pid: session.pid };
  }

  terminateAll(): number[] {
    const pids: number[] = [];
    for (const session of this.sessions.values()) {
      if (session.state === SessionState.TERMINATED) continue;
      this.updateState(session.id, SessionState.TERMINATED);
      if (session.mode === "json" && session.pid !== undefined) {
        pids.push(session.pid);
      }
    }
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

  recordHeartbeat(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.lastHeartbeat = Date.now();
  }

  getStaleSessionIds(thresholdMs: number = this.heartbeatTimeoutMs): string[] {
    const now = Date.now();
    const stale: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.mode !== "pty") continue;
      if (session.state === SessionState.TERMINATED) continue;
      if (
        session.lastHeartbeat !== undefined &&
        now - session.lastHeartbeat > thresholdMs
      ) {
        stale.push(session.id);
      }
    }
    return stale;
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
    // 检查 JSON 会话的子进程是否存活
    for (const session of this.sessions.values()) {
      if (session.mode === "json" && session.pid !== undefined && session.state !== SessionState.TERMINATED) {
        if (!this.isProcessAlive(session.pid)) {
          this.updateState(session.id, SessionState.TERMINATED);
        }
      }
    }
    // 检查 PTY 会话心跳是否超时
    const staleIds = this.getStaleSessionIds();
    for (const id of staleIds) {
      this.updateState(id, SessionState.TERMINATED);
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
        `Failed to parse session persistence file at ${this.persistPath}: ${err}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Session persistence file has invalid format at ${this.persistPath}: expected array`,
      );
    }
    for (const item of parsed) {
      const info = item as SessionInfo;
      // 过滤掉已终止的会话，重启后不需要保留
      if (info.state === SessionState.TERMINATED) continue;
      this.sessions.set(info.id, info);
    }
  }
}
