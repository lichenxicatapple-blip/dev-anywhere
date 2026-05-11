import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionManager } from "#src/serve/session-manager.js";
import { SessionState } from "@dev-anywhere/shared";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "session-mgr-test-"));
}

// 测试用 PID 常量
const ALIVE_PID = process.pid;
const DEAD_PID = 999999;

describe("SessionManager", () => {
  let persistPath: string;
  let manager: SessionManager;

  beforeEach(() => {
    persistPath = join(makeTmpDir(), "sessions.json");
    manager = new SessionManager({ persistPath });
  });

  afterEach(() => {
    manager.stopReaper();
  });

  describe("createSession", () => {
    it("creates a PTY session with unique id and idle state", () => {
      const info = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(typeof info.id).toBe("string");
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.mode).toBe("pty");
      expect(info.provider).toBe("claude");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
      expect(info.createdAt).toBeGreaterThan(0);
    });

    it("creates a JSON session with unique id and idle state", () => {
      const info = manager.createSession("json", "/tmp/test", ALIVE_PID);
      expect(typeof info.id).toBe("string");
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.mode).toBe("json");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
    });

    it("stores optional name in SessionInfo", () => {
      const info = manager.createSession("pty", "/tmp/test", ALIVE_PID, "my-session");
      expect(info.name).toBe("my-session");
    });

    it("stores provider in SessionInfo", () => {
      const info = manager.createSession(
        "pty",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "codex",
      );
      expect(info.provider).toBe("codex");
    });

    it("stores PTY owner only for PTY sessions", () => {
      const pty = manager.createSession(
        "pty",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "claude",
        "local-terminal",
      );
      const json = manager.createSession(
        "json",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "claude",
        "proxy-hosted",
      );

      expect(pty.ptyOwner).toBe("local-terminal");
      expect(json.ptyOwner).toBeUndefined();
    });

    it("generates unique IDs for each session", () => {
      const s1 = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      const s2 = manager.createSession("json", "/tmp/test", ALIVE_PID);
      expect(s1.id).not.toBe(s2.id);
    });

    it("persists session to file after creation", () => {
      manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].provider).toBe("claude");
    });
  });

  describe("listSessions", () => {
    it("returns sessions sorted by createdAt descending", () => {
      const s1 = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.getSession(s1.id)!.createdAt = 1000;
      const s2 = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.getSession(s2.id)!.createdAt = 2000;
      const list = manager.listSessions();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(s2.id);
      expect(list[1].id).toBe(s1.id);
    });

    it("returns empty array when no sessions exist", () => {
      expect(manager.listSessions()).toEqual([]);
    });
  });

  describe("getSession", () => {
    it("returns SessionInfo for existing session", () => {
      const created = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      const found = manager.getSession(created.id);
      expect(found?.id).toBe(created.id);
    });

    it("returns undefined for non-existent session", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("updateState", () => {
    it("transitions idle -> working", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });

    it("transitions working -> waiting_approval", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);
    });

    it("PTY session allows idle -> waiting_approval for provider hook PermissionRequest", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(manager.updateState(s.id, SessionState.WAITING_APPROVAL)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);
    });

    it("JSON session transitions waiting_approval -> idle directly (粒度丢失：proxy 观察不到审批后的 WORKING 中间态)", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("PTY session allows waiting_approval -> idle when provider ends the turn after approval", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions working -> idle", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("JSON session transitions idle -> error (observer channel lost)", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.ERROR);
    });

    it("PTY session rejects transition into error and returns false (no ERROR state for PTY)", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(manager.updateState(s.id, SessionState.ERROR)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions any state -> terminated", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("rejects terminated -> any state (absorbing) and returns false", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("JSON session rejects error -> idle and returns false (error only goes to terminated)", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.ERROR);
    });

    it("JSON session allows error -> terminated", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("PTY session allows waiting_approval -> working (approval resolved, claude resumes)", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      manager.updateState(s.id, SessionState.WORKING);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });

    it("JSON session rejects waiting_approval -> working (proxy cannot observe mid-approval resumption)", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.updateState(s.id, SessionState.WORKING)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);
    });

    it("throws for non-existent session", () => {
      expect(() => manager.updateState("nonexistent", SessionState.WORKING)).toThrow();
    });

    it("does not persist runtime state to file (state is observation, not identity)", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      const saved = data.find((d: { id: string }) => d.id === s.id);
      expect(saved.state).toBeUndefined();
    });
  });

  describe("terminateSession", () => {
    it("removes PTY session from registry", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      const result = manager.terminateSession(s.id);
      expect(result.success).toBe(true);
      expect(manager.getSession(s.id)).toBeUndefined();
    });

    it("returns pid for JSON sessions", () => {
      const s = manager.createSession("json", "/tmp/test", 12345);
      const result = manager.terminateSession(s.id);
      expect(result.success).toBe(true);
      expect(result.pid).toBe(12345);
    });

    it("returns false for non-existent session", () => {
      const result = manager.terminateSession("nonexistent");
      expect(result.success).toBe(false);
    });

    it("passes remove context to lifecycle cleanup", () => {
      const contexts: unknown[] = [];
      const scoped = new SessionManager({
        persistPath,
        onSessionRemoved: (_id, context) => contexts.push(context),
      });
      const s = scoped.createSession("pty", "/tmp/test", ALIVE_PID);

      scoped.terminateSession(s.id, { preserveProviderHooks: true });

      expect(contexts).toEqual([{ preserveProviderHooks: true }]);
      scoped.stopReaper();
    });

    // onSessionRemoved 内的某步抛异常 (例如 permissionBroker.cleanupSession /
    // hookRegistry 落盘失败) 不能让 terminateSession 自己抛, 否则调用方 (如 socket
    // close handler) 后续的 cleanupSessionResources + broadcastSessionList 会被吞掉,
    // web 看到 session 残留。
    it("does not propagate exceptions from onSessionRemoved callback", () => {
      const scoped = new SessionManager({
        persistPath,
        onSessionRemoved: () => {
          throw new Error("hook unregister boom");
        },
      });
      const s = scoped.createSession("pty", "/tmp/test", ALIVE_PID);

      expect(() => scoped.terminateSession(s.id)).not.toThrow();
      expect(scoped.getSession(s.id)).toBeUndefined();
      scoped.stopReaper();
    });
  });

  describe("terminateAll", () => {
    it("removes all sessions and returns JSON PIDs", () => {
      manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.createSession("json", "/tmp/test", 55555);
      const pids = manager.terminateAll();
      expect(manager.listSessions()).toHaveLength(0);
      expect(pids).toEqual([55555]);
    });

    it("returns pids for JSON sessions", () => {
      manager.createSession("json", "/tmp/test", 111);
      manager.createSession("json", "/tmp/test", 222);
      const pids = manager.terminateAll();
      expect(pids).toContain(111);
      expect(pids).toContain(222);
    });

    it("skips already terminated sessions", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.TERMINATED);
      const pids = manager.terminateAll();
      expect(pids).toEqual([]);
    });
  });

  describe("setClaudeSessionId", () => {
    it("stores claudeSessionId on session", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.setClaudeSessionId(s.id, "claude-abc");
      expect(manager.getSession(s.id)!.claudeSessionId).toBe("claude-abc");
    });
  });

  describe("setPid", () => {
    it("updates pid on session for PTY reconnection", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.setPid(s.id, 9999);
      expect(manager.getSession(s.id)!.pid).toBe(9999);
    });
  });

  describe("persistence", () => {
    it("loads sessions from existing file on construction", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID, "persisted");
      const manager2 = new SessionManager({ persistPath });
      expect(manager2.getSession(s.id)?.name).toBe("persisted");
      manager2.stopReaper();
    });

    it("terminated sessions do not reappear on load", () => {
      const s1 = manager.createSession("json", "/tmp/test", ALIVE_PID);
      const s2 = manager.createSession("json", "/tmp/test", ALIVE_PID, "kept");
      manager.terminateSession(s1.id);
      const manager2 = new SessionManager({ persistPath });
      expect(manager2.getSession(s1.id)).toBeUndefined();
      expect(manager2.getSession(s2.id)?.name).toBe("kept");
      manager2.stopReaper();
    });

    it("skips PTY sessions on restore when terminal process is dead", () => {
      const pty = manager.createSession("pty", "/tmp/test", DEAD_PID);
      const json = manager.createSession("json", "/tmp/test", ALIVE_PID, "alive");
      const manager2 = new SessionManager({ persistPath });
      expect(manager2.getSession(pty.id)).toBeUndefined();
      expect(manager2.getSession(json.id)?.name).toBe("alive");
      manager2.stopReaper();
    });

    it("starts with empty map when file does not exist", () => {
      const freshPath = join(makeTmpDir(), "fresh.json");
      const fresh = new SessionManager({ persistPath: freshPath });
      expect(fresh.listSessions()).toEqual([]);
      fresh.stopReaper();
    });

    it("fails soft on corrupt persistence file (warn + empty state, daemon still boots)", () => {
      // 抛错路径会让 proxy daemon 起不来, 用户必须手删文件才能恢复——不友好。
      // fail-soft: 警告 + 退化为空 session 列表, 还活着的 worker 通过 reconnectAll 走
      // worker.sock 探活补回, 仅丢失元数据 (name / cwd 等)。
      writeFileSync(persistPath, "not-valid-json{{{", "utf-8");
      const mgr = new SessionManager({ persistPath });
      expect(mgr.listSessions()).toEqual([]);
      mgr.stopReaper();
    });

    it("uses atomic write (temp + rename)", () => {
      manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(Array.isArray(data)).toBe(true);
    });

    it("any in-memory state resets to IDLE on load (state is observation, discarded across restart)", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);

      const manager2 = new SessionManager({ persistPath });
      const restored = manager2.getSession(s.id);
      expect(restored?.state).toBe(SessionState.IDLE);
      expect(restored?.provider).toBe("claude");
      manager2.stopReaper();
    });

    it("skips persisted sessions with state field, keeping the rest loadable", () => {
      const goodId = "good-session";
      const badId = "bad-session";
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: badId,
            mode: "json",
            provider: "claude",
            cwd: "/tmp/test",
            pid: ALIVE_PID,
            state: SessionState.WORKING,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: goodId,
            mode: "json",
            provider: "claude",
            cwd: "/tmp/test",
            pid: ALIVE_PID,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.getSession(goodId)?.state).toBe(SessionState.IDLE);
      expect(manager2.getSession(badId)).toBeUndefined();
      expect(removedIds).toContain(badId);
      manager2.stopReaper();
    });

    it("cleans persisted sessions without provider", () => {
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "invalid",
            mode: "json",
            cwd: "/tmp/test",
            pid: ALIVE_PID,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual(["invalid"]);
      manager2.stopReaper();
    });
  });

  describe("PTY session cleanup on load()", () => {
    it("does not delete data when PTY session PID is alive", () => {
      const removedIds: string[] = [];
      manager.createSession("pty", "/tmp/test", ALIVE_PID);

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      // PTY 会话不加载到内存（即使进程存活），但也不触发 onSessionRemoved
      expect(removedIds).toHaveLength(0);
      manager2.stopReaper();
    });

    it("deletes data when PTY session PID is dead", () => {
      const removedIds: string[] = [];
      manager.createSession("pty", "/tmp/test", DEAD_PID);

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(removedIds).toHaveLength(1);
      manager2.stopReaper();
    });

    it("cleans JSON sessions with dead PID on load", () => {
      const removedIds: string[] = [];
      manager.createSession("json", "/tmp/test", DEAD_PID, "dead-pid");

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(removedIds).toHaveLength(1);
      manager2.stopReaper();
    });

    it("restores JSON sessions with alive PID on load", () => {
      const removedIds: string[] = [];
      const json = manager.createSession("json", "/tmp/test", ALIVE_PID, "alive");

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      const restored = manager2.getSession(json.id);
      expect(restored?.name).toBe("alive");
      expect(restored?.mode).toBe("json");
      expect(removedIds).not.toContain(json.id);
      manager2.stopReaper();
    });
  });

  describe("reaper", () => {
    it("removes dead JSON sessions from registry", () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal?) => {
        throw new Error("ESRCH");
      });

      const s = manager.createSession("json", "/tmp/test", 99999);
      manager.updateState(s.id, SessionState.WORKING);

      manager.startReaper(1000);
      vi.advanceTimersByTime(1100);

      expect(manager.getSession(s.id)).toBeUndefined();

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("does not terminate JSON sessions with alive processes", () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal?) => {
        return true;
      });

      const s = manager.createSession("json", "/tmp/test", 99999);
      manager.updateState(s.id, SessionState.WORKING);

      manager.startReaper(1000);
      vi.advanceTimersByTime(1100);

      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("stopReaper clears the interval", () => {
      vi.useFakeTimers();

      const s = manager.createSession("json", "/tmp/test", 99999);
      manager.updateState(s.id, SessionState.WORKING);

      manager.startReaper(1000);
      manager.stopReaper();

      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal?) => {
        throw new Error("ESRCH");
      });

      vi.advanceTimersByTime(5000);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);

      killSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
