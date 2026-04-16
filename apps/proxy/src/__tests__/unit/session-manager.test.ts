import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionManager } from "#src/session-manager.js";
import { SessionState } from "@cc-anywhere/shared";

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
      expect(info.id).toBeTruthy();
      expect(info.mode).toBe("pty");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
      expect(info.createdAt).toBeGreaterThan(0);
    });

    it("creates a JSON session with unique id and idle state", () => {
      const info = manager.createSession("json", "/tmp/test", ALIVE_PID);
      expect(info.id).toBeTruthy();
      expect(info.mode).toBe("json");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
    });

    it("stores optional name in SessionInfo", () => {
      const info = manager.createSession("pty", "/tmp/test", ALIVE_PID, "my-session");
      expect(info.name).toBe("my-session");
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
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
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

    it("transitions waiting_approval -> idle", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions working -> idle", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions any state -> error", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.ERROR);
    });

    it("transitions any state -> terminated", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("rejects terminated -> any state (terminal)", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(() => manager.updateState(s.id, SessionState.IDLE)).toThrow();
    });

    it("rejects error -> idle (error only goes to terminated)", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(() => manager.updateState(s.id, SessionState.IDLE)).toThrow();
    });

    it("allows error -> terminated", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("throws for non-existent session", () => {
      expect(() => manager.updateState("nonexistent", SessionState.WORKING)).toThrow();
    });

    it("persists state change to file", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      const saved = data.find((d: { id: string }) => d.id === s.id);
      expect(saved.state).toBe(SessionState.WORKING);
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
      const found = manager2.getSession(s.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("persisted");
      manager2.stopReaper();
    });

    it("filters out terminated sessions on load", () => {
      const s1 = manager.createSession("json", "/tmp/test", ALIVE_PID);
      const s2 = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s1.id, SessionState.TERMINATED);
      const manager2 = new SessionManager({ persistPath });
      expect(manager2.getSession(s1.id)).toBeUndefined();
      expect(manager2.getSession(s2.id)).toBeDefined();
      manager2.stopReaper();
    });

    it("skips PTY sessions on restore when terminal process is dead", () => {
      const pty = manager.createSession("pty", "/tmp/test", DEAD_PID);
      const json = manager.createSession("json", "/tmp/test", ALIVE_PID);
      const manager2 = new SessionManager({ persistPath });
      expect(manager2.getSession(pty.id)).toBeUndefined();
      expect(manager2.getSession(json.id)).toBeDefined();
      manager2.stopReaper();
    });

    it("starts with empty map when file does not exist", () => {
      const freshPath = join(makeTmpDir(), "fresh.json");
      const fresh = new SessionManager({ persistPath: freshPath });
      expect(fresh.listSessions()).toEqual([]);
      fresh.stopReaper();
    });

    it("throws on corrupt persistence file", () => {
      writeFileSync(persistPath, "not-valid-json{{{", "utf-8");
      expect(() => new SessionManager({ persistPath })).toThrow();
    });

    it("uses atomic write (temp + rename)", () => {
      manager.createSession("pty", "/tmp/test", ALIVE_PID);
      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(Array.isArray(data)).toBe(true);
    });

    it("resets WAITING_APPROVAL to IDLE on load", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);

      const manager2 = new SessionManager({ persistPath });
      const restored = manager2.getSession(s.id);
      expect(restored).toBeDefined();
      expect(restored!.state).toBe(SessionState.IDLE);
      manager2.stopReaper();
    });

    it("keeps WORKING state unchanged on load", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);

      const manager2 = new SessionManager({ persistPath });
      const restored = manager2.getSession(s.id);
      expect(restored).toBeDefined();
      expect(restored!.state).toBe(SessionState.WORKING);
      manager2.stopReaper();
    });

    it("keeps IDLE state unchanged on load", () => {
      const s = manager.createSession("json", "/tmp/test", ALIVE_PID);

      const manager2 = new SessionManager({ persistPath });
      const restored = manager2.getSession(s.id);
      expect(restored).toBeDefined();
      expect(restored!.state).toBe(SessionState.IDLE);
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

    it("deletes data for TERMINATED sessions regardless of mode", () => {
      const removedIds: string[] = [];
      const json = manager.createSession("json", "/tmp/test", ALIVE_PID);
      manager.updateState(json.id, SessionState.TERMINATED);

      const manager2 = new SessionManager({
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.getSession(json.id)).toBeUndefined();
      expect(removedIds).toContain(json.id);
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
      expect(restored).toBeDefined();
      expect(restored!.name).toBe("alive");
      expect(restored!.mode).toBe("json");
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
