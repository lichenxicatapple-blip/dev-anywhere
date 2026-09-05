import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionManager } from "#src/serve/session-manager.js";
import * as historyMetadata from "#src/serve/session-history-metadata.js";
import { sessionRuntimeIpcVersionMatches } from "#src/common/session-runtime-ipc-version.js";
import {
  TERMINAL_IPC_PROTOCOL_VERSION,
  WORKER_IPC_PROTOCOL_VERSION,
} from "#src/ipc/ipc-protocol.js";
import { SessionState } from "@dev-anywhere/shared";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "session-mgr-test-"));
}

// 测试用 PID 常量
const ALIVE_PID = process.pid;
const DEAD_PID = 999999;

describe("SessionManager", () => {
  let persistPath: string;
  let historyMetadataPath: string;
  let manager: SessionManager;

  beforeEach(() => {
    const dir = makeTmpDir();
    persistPath = join(dir, "sessions.json");
    historyMetadataPath = join(dir, "history-metadata.json");
    manager = new SessionManager({
      allowSessionRuntimeHandover: { terminal: true, worker: true },
      persistPath,
      historyMetadataPath,
    });
  });

  afterEach(() => {
    manager.stopReaper();
    vi.useRealTimers();
  });

  describe("createSession", () => {
    it("creates a PTY session with unique id and idle state", () => {
      const info = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(typeof info.id).toBe("string");
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.kind).toBe("agent");
      expect(info.mode).toBe("pty");
      expect(info.provider).toBe("claude");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
      expect(info.createdAt).toBeGreaterThan(0);
    });

    it("creates a JSON session with unique id and idle state", () => {
      const info = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      expect(typeof info.id).toBe("string");
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.mode).toBe("json");
      expect(info.state).toBe(SessionState.IDLE);
      expect(info.pid).toBe(ALIVE_PID);
    });

    it("stores optional name in SessionInfo", () => {
      const info = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "my-session",
        undefined,
        "local-terminal",
      );
      expect(info.name).toBe("my-session");
    });

    it("stores a locked title when session_create receives an explicit user title", () => {
      const info = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "Release checklist",
        undefined,
        undefined,
        true,
      );
      expect(info).toMatchObject({
        name: "Release checklist",
        nameLocked: true,
      });
      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(info.id)).toMatchObject({
        name: "Release checklist",
        nameLocked: true,
      });
      manager2.stopReaper();
    });

    it("stores provider in SessionInfo", () => {
      const info = manager.createSession(
        "agent",
        "pty",
        "codex",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(info.provider).toBe("codex");
    });

    it("stores Kimi as a first-class PTY provider", () => {
      const info = manager.createSession(
        "agent",
        "pty",
        "kimi",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(info.provider).toBe("kimi");
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toContainEqual(
        expect.objectContaining({ id: info.id, provider: "kimi" }),
      );
    });

    it("stores PTY owner only for PTY sessions", () => {
      const pty = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      const json = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);

      expect(pty.ptyOwner).toBe("local-terminal");
      expect(json.ptyOwner).toBeUndefined();
    });

    it("generates unique IDs for each session", () => {
      const s1 = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      const s2 = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      expect(s1.id).not.toBe(s2.id);
    });

    it("persists session to file after creation", () => {
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].kind).toBe("agent");
      expect(data[0].provider).toBe("claude");
    });

    it("rejects incomplete runtime identity before mutating the registry", () => {
      expect(() => manager.createSession("agent", "json", "claude", "/tmp/test", 0)).toThrow(
        "Session PID must be a positive safe integer",
      );
      expect(() => manager.createSession("agent", "json", "claude", "", ALIVE_PID)).toThrow(
        "Session cwd cannot be empty",
      );
      expect(manager.listSessions()).toEqual([]);
    });
  });

  describe("listSessions", () => {
    it("returns sessions sorted by createdAt descending", () => {
      const s1 = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.getSession(s1.id)!.createdAt = 1000;
      const s2 = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
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
      const created = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      const found = manager.getSession(created.id);
      expect(found?.id).toBe(created.id);
    });

    it("returns undefined for non-existent session", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("updateState", () => {
    it("transitions idle -> working", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });

    it("transitions working -> waiting_approval", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);
    });

    it("PTY session allows idle -> waiting_approval for provider hook PermissionRequest", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(manager.updateState(s.id, SessionState.WAITING_APPROVAL)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WAITING_APPROVAL);
    });

    it("JSON session transitions waiting_approval -> idle directly (粒度丢失：proxy 观察不到审批后的 WORKING 中间态)", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("PTY session allows waiting_approval -> idle when provider ends the turn after approval", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions working -> idle", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.IDLE);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("JSON session transitions idle -> error (observer channel lost)", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.ERROR);
    });

    it("JSON session transitions idle -> compacting -> idle for native /compact", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      expect(manager.updateState(s.id, SessionState.COMPACTING)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.COMPACTING);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("PTY session rejects compacting because native /compact is JSON-only", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(manager.updateState(s.id, SessionState.COMPACTING)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("PTY session rejects transition into error and returns false (no ERROR state for PTY)", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(manager.updateState(s.id, SessionState.ERROR)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.IDLE);
    });

    it("transitions any state -> terminated", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("rejects terminated -> any state (absorbing) and returns false", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("JSON session rejects error -> idle and returns false (error only goes to terminated)", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      expect(manager.updateState(s.id, SessionState.IDLE)).toBe(false);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.ERROR);
    });

    it("JSON session allows error -> terminated", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.ERROR);
      manager.updateState(s.id, SessionState.TERMINATED);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.TERMINATED);
    });

    it("PTY session allows waiting_approval -> working (approval resolved, claude resumes)", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      manager.updateState(s.id, SessionState.WORKING);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });

    it("JSON session allows waiting_approval -> working after approval is resolved", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);
      expect(manager.updateState(s.id, SessionState.WORKING)).toBe(true);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });

    it("throws for non-existent session", () => {
      expect(() => manager.updateState("nonexistent", SessionState.WORKING)).toThrow();
    });

    it("does not persist runtime state to file (state is observation, not identity)", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.WORKING);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      const saved = data.find((d: { id: string }) => d.id === s.id);
      expect(saved.state).toBeUndefined();
    });
  });

  describe("terminateSession", () => {
    it("removes PTY session from registry", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      const result = manager.terminateSession(s.id);
      expect(result.success).toBe(true);
      expect(manager.getSession(s.id)).toBeUndefined();
    });

    it("returns pid for JSON sessions", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", 12345);
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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: (_id, context) => contexts.push(context),
      });
      const s = scoped.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );

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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: () => {
          throw new Error("hook unregister boom");
        },
      });
      const s = scoped.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );

      expect(() => scoped.terminateSession(s.id)).not.toThrow();
      expect(scoped.getSession(s.id)).toBeUndefined();
      scoped.stopReaper();
    });
  });

  describe("terminateAll", () => {
    it("removes all sessions and returns JSON PIDs", () => {
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.createSession("agent", "json", "claude", "/tmp/test", 55555);
      const pids = manager.terminateAll();
      expect(manager.listSessions()).toHaveLength(0);
      expect(pids).toEqual([55555]);
    });

    it("returns pids for JSON sessions", () => {
      manager.createSession("agent", "json", "claude", "/tmp/test", 111);
      manager.createSession("agent", "json", "claude", "/tmp/test", 222);
      const pids = manager.terminateAll();
      expect(pids).toContain(111);
      expect(pids).toContain(222);
    });

    it("skips already terminated sessions", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.updateState(s.id, SessionState.TERMINATED);
      const pids = manager.terminateAll();
      expect(pids).toEqual([]);
    });
  });

  describe("setClaudeSessionId", () => {
    it("stores claudeSessionId on session", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.setClaudeSessionId(s.id, "claude-abc");
      expect(manager.getSession(s.id)!.claudeSessionId).toBe("claude-abc");
    });

    it("records the restore mode without saving an automatic session name as a user title", () => {
      const s = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "chat session",
      );

      manager.setClaudeSessionId(s.id, "claude-json-abc");

      const data = JSON.parse(readFileSync(historyMetadataPath, "utf-8"));
      expect(data).toEqual([
        expect.objectContaining({
          nativeSessionId: "claude-json-abc",
          devAnywhereSessionId: s.id,
          provider: "claude",
          mode: "json",
          cwd: "/tmp/test",
        }),
      ]);
      expect(data[0]).not.toHaveProperty("title");
      expect(data[0]).not.toHaveProperty("nameLocked");
      expect(manager.getSession(s.id)?.name).toBe("chat session");
    });

    it.each(["claude", "codex", "kimi"] as const)(
      "records an explicit creation name when the %s native ID is captured",
      (provider) => {
        const session = manager.createSession(
          "agent",
          "json",
          provider,
          "/tmp/test",
          ALIVE_PID,
          "User title",
          undefined,
          undefined,
          true,
        );

        if (provider === "claude") manager.setClaudeSessionId(session.id, "native-session");
        else manager.setHistorySessionId(session.id, "native-session");

        expect(historyMetadata.readSessionHistoryMetadata(historyMetadataPath)).toEqual([
          expect.objectContaining({
            nativeSessionId: "native-session",
            provider,
            title: "User title",
            nameLocked: true,
          }),
        ]);
      },
    );

    it("does not erase a stored user title when a resumed runtime gets an automatic name", () => {
      const original = manager.createSession("agent", "json", "kimi", "/tmp/test", ALIVE_PID);
      manager.setHistorySessionId(original.id, "native-kimi");
      manager.renameSession(original.id, "Saved name");
      manager.terminateSession(original.id);
      const resumed = manager.createSession(
        "agent",
        "json",
        "kimi",
        "/tmp/test",
        ALIVE_PID,
        "~/test",
      );

      manager.setHistorySessionId(resumed.id, "native-kimi");

      expect(historyMetadata.readSessionHistoryMetadata(historyMetadataPath)).toEqual([
        expect.objectContaining({
          nativeSessionId: "native-kimi",
          devAnywhereSessionId: resumed.id,
          title: "Saved name",
          nameLocked: true,
        }),
      ]);
      expect(manager.getSession(resumed.id)).toMatchObject({ name: "~/test" });
      expect(manager.getSession(resumed.id)?.nameLocked).toBeUndefined();
    });

    it("stores resumed history session separately from the active Claude session", () => {
      const s = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "chat session",
      );

      manager.setHistorySessionId(s.id, "claude-resume-abc");
      manager.setClaudeSessionId(s.id, "claude-active-def");

      expect(manager.getSession(s.id)).toMatchObject({
        historySessionId: "claude-resume-abc",
        claudeSessionId: "claude-active-def",
      });
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(data[0]).toMatchObject({
        historySessionId: "claude-resume-abc",
        claudeSessionId: "claude-active-def",
      });
    });
  });

  describe("setPid", () => {
    it("updates pid on session for PTY reconnection", () => {
      const s = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      manager.setPid(s.id, 9999);
      expect(manager.getSession(s.id)!.pid).toBe(9999);
    });
  });

  describe("updateTerminalCwd", () => {
    it("updates and persists an absolute working directory for a pure terminal", () => {
      const session = manager.createSession(
        "terminal",
        "pty",
        "claude",
        "/Users/dev",
        ALIVE_PID,
        undefined,
        undefined,
        "proxy-hosted",
      );

      expect(manager.updateTerminalCwd(session.id, "/Users/dev/My Project/../repo")).toBe(true);
      expect(manager.getSession(session.id)?.cwd).toBe("/Users/dev/repo");

      const persisted = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(persisted).toContainEqual(expect.objectContaining({ cwd: "/Users/dev/repo" }));
    });

    it("ignores relative paths, unchanged paths, and agent sessions", () => {
      const terminal = manager.createSession(
        "terminal",
        "pty",
        "claude",
        "/Users/dev",
        ALIVE_PID,
        undefined,
        undefined,
        "proxy-hosted",
      );
      const agent = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/Users/dev",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );

      expect(manager.updateTerminalCwd(terminal.id, "relative/path")).toBe(false);
      expect(manager.updateTerminalCwd(terminal.id, "/Users/dev")).toBe(false);
      expect(manager.updateTerminalCwd(agent.id, "/tmp")).toBe(false);
      expect(manager.getSession(terminal.id)?.cwd).toBe("/Users/dev");
      expect(manager.getSession(agent.id)?.cwd).toBe("/Users/dev");
    });
  });

  describe("renameSession", () => {
    it.each(["codex", "kimi"] as const)(
      "persists a user rename through the %s historySessionId",
      (provider) => {
        const session = manager.createSession("agent", "json", provider, "/tmp/test", ALIVE_PID);
        manager.setHistorySessionId(session.id, "native-session");

        manager.renameSession(session.id, "User title");

        expect(historyMetadata.readSessionHistoryMetadata(historyMetadataPath)).toEqual([
          expect.objectContaining({
            nativeSessionId: "native-session",
            provider,
            title: "User title",
            nameLocked: true,
          }),
        ]);
      },
    );

    it("updates both the source and current native IDs of a resumed Claude conversation", () => {
      const session = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.setHistorySessionId(session.id, "source-native");
      manager.setClaudeSessionId(session.id, "current-native");

      manager.renameSession(session.id, "User title");

      const records = historyMetadata.readSessionHistoryMetadata(historyMetadataPath);
      expect(records.map((record) => record.nativeSessionId).sort()).toEqual([
        "current-native",
        "source-native",
      ]);
      expect(records.every((record) => record.title === "User title" && record.nameLocked)).toBe(
        true,
      );
    });

    it("writes a rename once when the source and current native IDs are identical", () => {
      const session = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.setHistorySessionId(session.id, "same-native");
      manager.setClaudeSessionId(session.id, "same-native");
      const upsert = vi.spyOn(historyMetadata, "upsertSessionHistoryMetadata");
      try {
        manager.renameSession(session.id, "User title");

        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith(
          historyMetadataPath,
          expect.objectContaining({
            nativeSessionId: "same-native",
            title: "User title",
            nameLocked: true,
          }),
        );
      } finally {
        upsert.mockRestore();
      }
    });

    it("stores a user locked display name and persists it", () => {
      const s = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/project",
        ALIVE_PID,
        "~/project",
      );

      const renamed = manager.renameSession(s.id, "  Release checklist  ");

      expect(renamed).toEqual({ success: true, name: "Release checklist" });
      expect(manager.getSession(s.id)).toMatchObject({
        name: "Release checklist",
        nameLocked: true,
        cwd: "/tmp/project",
      });

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(s.id)).toMatchObject({
        name: "Release checklist",
        nameLocked: true,
        cwd: "/tmp/project",
      });
      manager2.stopReaper();
    });

    it("rejects empty rename titles without changing the session", () => {
      const s = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/project",
        ALIVE_PID,
        "~/project",
      );

      const renamed = manager.renameSession(s.id, "   ");

      expect(renamed.success).toBe(false);
      expect(manager.getSession(s.id)).toMatchObject({
        name: "~/project",
      });
      expect(manager.getSession(s.id)?.nameLocked).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("loads sessions from existing file on construction", () => {
      const s = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "persisted",
      );
      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(s.id)?.name).toBe("persisted");
      expect(manager2.getSession(s.id)?.kind).toBe("agent");
      manager2.stopReaper();
    });

    it("terminated sessions do not reappear on load", () => {
      const s1 = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      const s2 = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID, "kept");
      manager.terminateSession(s1.id);
      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(s1.id)).toBeUndefined();
      expect(manager2.getSession(s2.id)?.name).toBe("kept");
      manager2.stopReaper();
    });

    it("skips PTY sessions on restore when terminal process is dead", () => {
      const pty = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        DEAD_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      const json = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "alive",
      );
      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(pty.id)).toBeUndefined();
      expect(manager2.getSession(json.id)?.name).toBe("alive");
      manager2.stopReaper();
    });

    it("starts with empty map when file does not exist", () => {
      const freshPath = join(makeTmpDir(), "fresh.json");
      const fresh = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath: freshPath,
      });
      expect(fresh.listSessions()).toEqual([]);
      fresh.stopReaper();
    });

    it("fails soft on corrupt persistence file (warn + empty state, daemon still boots)", () => {
      // 抛错路径会让 proxy daemon 起不来, 用户必须手删文件才能恢复——不友好。
      // fail-soft: 警告 + 退化为空 session 列表；没有权威记录的 worker 随后会被拒绝。
      writeFileSync(persistPath, "not-valid-json{{{", "utf-8");
      const mgr = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
      });
      expect(mgr.listSessions()).toEqual([]);
      mgr.stopReaper();
    });

    it("uses atomic write (temp + rename)", () => {
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );
      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf-8"));
      expect(Array.isArray(data)).toBe(true);
    });

    it("any in-memory state resets to IDLE on load (state is observation, discarded across restart)", () => {
      const s = manager.createSession("agent", "json", "claude", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      manager.updateState(s.id, SessionState.WAITING_APPROVAL);

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
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
            kind: "agent",
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
            kind: "agent",
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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
        terminateManagedSession: vi.fn(),
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
            kind: "agent",
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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual(["invalid"]);
      manager2.stopReaper();
    });

    it("cleans persisted sessions without a kind", () => {
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "missing-kind",
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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual(["missing-kind"]);
      manager2.stopReaper();
    });

    it("cleans persisted sessions without a mode", () => {
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "missing-mode",
            kind: "agent",
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
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual(["missing-mode"]);
      manager2.stopReaper();
    });
  });

  describe("PTY session cleanup on load()", () => {
    it("cleans an incompatible terminal generation without discarding compatible JSON workers", () => {
      manager.createSession(
        "agent",
        "pty",
        "kimi",
        "/tmp/test",
        4242,
        undefined,
        "incompatible-terminal",
        "local-terminal",
      );
      manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        5252,
        undefined,
        "compatible-json",
      );
      const expected = {
        terminal: TERMINAL_IPC_PROTOCOL_VERSION,
        worker: WORKER_IPC_PROTOCOL_VERSION,
      };
      const saved = { ...expected, terminal: TERMINAL_IPC_PROTOCOL_VERSION - 1 };
      const terminateManagedSession = vi.fn();
      const onSessionRemoved = vi.fn();
      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: {
          terminal: sessionRuntimeIpcVersionMatches(saved, expected, "terminal"),
          worker: sessionRuntimeIpcVersionMatches(saved, expected, "worker"),
        },
        isProcessAlive: () => true,
        isManagedSessionProcess: () => true,
        terminateManagedSession,
        onSessionRemoved,
      });

      expect(terminateManagedSession).toHaveBeenCalledExactlyOnceWith(4242);
      expect(onSessionRemoved).toHaveBeenCalledExactlyOnceWith("incompatible-terminal");
      expect(manager2.listSessions().map((session) => session.id)).toEqual(["compatible-json"]);
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([
        expect.objectContaining({ id: "compatible-json", mode: "json", pid: 5252 }),
      ]);
      manager2.stopReaper();
    });

    it("stops and removes a foreign-generation local PTY before validating required fields", () => {
      const terminateManagedSession = vi.fn();
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "foreign-local-terminal",
            mode: "pty",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            pid: 4242,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: false, worker: false },
        isProcessAlive: () => true,
        isManagedSessionProcess: () => true,
        terminateManagedSession,
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(terminateManagedSession).toHaveBeenCalledOnce();
      expect(terminateManagedSession).toHaveBeenCalledWith(4242);
      expect(removedIds).toEqual(["foreign-local-terminal"]);
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
    });

    it("stops and removes a foreign-generation JSON worker before validating required fields", () => {
      const terminateManagedSession = vi.fn();
      const inspectManagedProcess = vi.fn(() => true);
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "foreign-json-worker",
            mode: "json",
            provider: "codex",
            cwd: "/tmp/test",
            pid: 5252,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: false, worker: false },
        isProcessAlive: () => true,
        isManagedSessionProcess: inspectManagedProcess,
        terminateManagedSession,
      });

      expect(inspectManagedProcess).toHaveBeenCalledWith(
        5252,
        expect.objectContaining({
          id: "foreign-json-worker",
          mode: "json",
          provider: "codex",
          workerSocketPath: expect.stringContaining("/foreign-json-worker/worker.sock"),
        }),
      );
      expect(terminateManagedSession).toHaveBeenCalledWith(5252);
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
    });

    it("terminates an identity-verified foreign-generation hosted worker", () => {
      const terminateManagedSession = vi.fn();
      const inspectManagedProcess = vi.fn(() => true);
      const removedIds: string[] = [];
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "foreign-proxy-hosted-terminal",
            kind: "agent",
            mode: "pty",
            provider: "kimi",
            ptyOwner: "proxy-hosted",
            cwd: "/tmp/test",
            pid: 5353,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: false, worker: false },
        isProcessAlive: () => true,
        isManagedSessionProcess: inspectManagedProcess,
        terminateManagedSession,
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(inspectManagedProcess).toHaveBeenCalledWith(5353, {
        id: "foreign-proxy-hosted-terminal",
        kind: "agent",
        mode: "pty",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
      });
      expect(terminateManagedSession).toHaveBeenCalledExactlyOnceWith(5353);
      expect(removedIds).toEqual(["foreign-proxy-hosted-terminal"]);
      expect(manager2.listSessions()).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
    });

    it("does not signal a reused PID that fails managed-process identity checks", () => {
      const terminateManagedSession = vi.fn();
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "stale-json-worker",
            mode: "json",
            provider: "claude",
            cwd: "/tmp/test",
            pid: 6262,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: false, worker: false },
        isProcessAlive: () => true,
        isManagedSessionProcess: () => false,
        terminateManagedSession,
      });

      expect(terminateManagedSession).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
    });

    it("keeps same-generation local PTYs available for reconnect handover", () => {
      const terminateManagedSession = vi.fn();
      const inspectManagedProcess = vi.fn(() => true);
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        4242,
        "same generation",
        "same-generation-terminal",
        "local-terminal",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        isProcessAlive: () => true,
        isManagedSessionProcess: inspectManagedProcess,
        terminateManagedSession,
      });
      const reconnected = manager2.claimPtySession({
        ptyOwner: "local-terminal",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/test",
        pid: 4242,
        name: "same generation",
        sessionId: "same-generation-terminal",
      });

      expect(terminateManagedSession).not.toHaveBeenCalled();
      expect(inspectManagedProcess).not.toHaveBeenCalled();
      expect(reconnected.source).toBe("pending");
      expect(reconnected.session.id).toBe("same-generation-terminal");
      manager2.stopReaper();
    });

    it("reserves a live local PTY without relying on an OS command-line query", () => {
      const removedIds: string[] = [];
      const terminateManagedSession = vi.fn();
      const inspectManagedProcess = vi.fn(() => false);
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        4242,
        "unverified",
        "unverified-terminal",
        "local-terminal",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        isProcessAlive: () => true,
        isManagedSessionProcess: inspectManagedProcess,
        terminateManagedSession,
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual([]);
      expect(inspectManagedProcess).not.toHaveBeenCalled();
      expect(terminateManagedSession).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([
        expect.objectContaining({ id: "unverified-terminal", pid: 4242 }),
      ]);
      // Even a new CLI with a reused PID must not inherit the pending session without its ID.
      const fresh = manager2.claimPtySession({
        ptyOwner: "local-terminal",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/test",
        pid: 4242,
      });
      expect(fresh.source).toBe("created");
      expect(fresh.session.id).not.toBe("unverified-terminal");
      expect(manager2.listSessions()).toEqual([fresh.session]);
      const claimed = manager2.claimPtySession({
        ptyOwner: "local-terminal",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/test",
        pid: 4242,
        sessionId: "unverified-terminal",
      });
      expect(claimed.source).toBe("pending");
      expect(manager2.getSession("unverified-terminal")).toEqual(claimed.session);
      manager2.stopReaper();
    });

    it("keeps a live unclaimed PTY indefinitely and reaps it only after confirmed exit", () => {
      vi.useFakeTimers();
      let alive = true;
      const removedIds: string[] = [];
      const terminateManagedSession = vi.fn();
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        4242,
        "pending",
        "expiring-terminal",
        "local-terminal",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        isProcessAlive: () => alive,
        isManagedSessionProcess: () => true,
        terminateManagedSession,
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toHaveLength(1);
      manager2.startReaper(1_000);
      vi.advanceTimersByTime(120_000);
      expect(removedIds).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toHaveLength(1);
      expect(manager2.listSessions()).toEqual([]);
      alive = false;
      vi.advanceTimersByTime(1_000);
      expect(removedIds).toEqual(["expiring-terminal"]);
      expect(terminateManagedSession).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
      vi.useRealTimers();
    });

    it("only lets the same PID reclaim an active local PTY", () => {
      const active = manager.createSession(
        "agent",
        "pty",
        "kimi",
        "/tmp/project",
        4242,
        "active",
        "active-terminal",
        "local-terminal",
      );

      const claimed = manager.claimPtySession({
        ptyOwner: "local-terminal",
        kind: "agent",
        provider: "kimi",
        cwd: "/tmp/project",
        pid: 4242,
        sessionId: active.id,
      });
      expect(claimed).toEqual({ session: active, source: "active" });
      expect(() =>
        manager.claimPtySession({
          ptyOwner: "local-terminal",
          kind: "agent",
          provider: "kimi",
          cwd: "/tmp/project",
          pid: 4243,
          sessionId: active.id,
        }),
      ).toThrow("PTY reconnect identity does not match the session owner");
      expect(manager.getSession(active.id)?.pid).toBe(4242);
    });

    it("rejects an unknown caller-supplied local PTY session id", () => {
      expect(() =>
        manager.claimPtySession({
          ptyOwner: "local-terminal",
          kind: "agent",
          provider: "claude",
          cwd: "/tmp/project",
          pid: 4242,
          sessionId: "not-active-or-pending",
        }),
      ).toThrow("PTY reconnect session is not available for handover");
      expect(manager.getSession("not-active-or-pending")).toBeUndefined();
    });

    it("retains a live hosted worker for exact IPC reclaim without an OS query", () => {
      const removedIds: string[] = [];
      const inspectManagedProcess = vi.fn(() => false);
      writeFileSync(
        persistPath,
        JSON.stringify([
          {
            id: "same-generation-proxy-hosted",
            kind: "agent",
            mode: "pty",
            provider: "kimi",
            ptyOwner: "proxy-hosted",
            cwd: "/tmp/test",
            pid: 5353,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
        "utf-8",
      );

      const manager2 = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        isProcessAlive: () => true,
        isManagedSessionProcess: inspectManagedProcess,
        terminateManagedSession: vi.fn(),
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(manager2.listSessions()).toEqual([]);
      expect(removedIds).toEqual([]);
      expect(inspectManagedProcess).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toHaveLength(1);
      const claim = manager2.claimPtySession({
        sessionId: "same-generation-proxy-hosted",
        kind: "agent",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/test",
        pid: 5353,
      });
      expect(claim.source).toBe("pending");
      expect(manager2.listSessions()).toEqual([claim.session]);
      manager2.stopReaper();
    });

    it.each([
      ["provider", { provider: "codex" }],
      ["pid", { pid: 4243 }],
      ["kind", { kind: "terminal", ptyOwner: "proxy-hosted" }],
      ["owner", { ptyOwner: "proxy-hosted" }],
    ] as const)(
      "rejects a PTY reconnect whose %s differs from the persisted identity",
      (_field, changedIdentity) => {
        manager.createSession(
          "agent",
          "pty",
          "claude",
          "/tmp/test",
          4242,
          "same generation",
          "current-terminal",
          "local-terminal",
        );

        const manager2 = new SessionManager({
          persistPath,
          allowSessionRuntimeHandover: { terminal: true, worker: true },
          isProcessAlive: () => true,
          isManagedSessionProcess: () => true,
        });
        expect(() =>
          manager2.claimPtySession({
            ptyOwner: "local-terminal",
            kind: "agent",
            provider: "claude",
            cwd: "/tmp/test",
            pid: 4242,
            name: "same generation",
            sessionId: "current-terminal",
            ...changedIdentity,
          }),
        ).toThrow("PTY reconnect identity does not match the session owner");
        expect(manager2.getSession("current-terminal")).toBeUndefined();
        manager2.stopReaper();
      },
    );

    it("does not delete data when PTY session PID is alive", () => {
      const removedIds: string[] = [];
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        undefined,
        undefined,
        "local-terminal",
      );

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      // PTY 会话不加载到内存（即使进程存活），但也不触发 onSessionRemoved
      expect(removedIds).toHaveLength(0);
      manager2.stopReaper();
    });

    it("keeps a user locked PTY name authoritative when the terminal reconnects after proxy restart", () => {
      const pty = manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/project",
        ALIVE_PID,
        "~/project",
        undefined,
        "local-terminal",
      );
      manager.renameSession(pty.id, "Release checklist");

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
      });
      expect(manager2.getSession(pty.id)).toBeUndefined();

      const reconnected = manager2.claimPtySession({
        ptyOwner: "local-terminal",
        kind: "agent",
        provider: "claude",
        cwd: "/tmp/project",
        pid: ALIVE_PID,
        name: "~/project",
        sessionId: pty.id,
      }).session;

      expect(reconnected).toMatchObject({
        id: pty.id,
        name: "Release checklist",
        nameLocked: true,
      });
      expect(manager2.getSession(pty.id)).toMatchObject({
        name: "Release checklist",
        nameLocked: true,
      });
      manager2.stopReaper();
    });

    it("deletes data when PTY session PID is dead", () => {
      const removedIds: string[] = [];
      manager.createSession(
        "agent",
        "pty",
        "claude",
        "/tmp/test",
        DEAD_PID,
        undefined,
        undefined,
        "local-terminal",
      );

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: () => true,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(removedIds).toHaveLength(1);
      manager2.stopReaper();
    });

    it("cleans JSON sessions with dead PID on load", () => {
      const removedIds: string[] = [];
      manager.createSession("agent", "json", "claude", "/tmp/test", DEAD_PID, "dead-pid");

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      expect(removedIds).toHaveLength(1);
      manager2.stopReaper();
    });

    it("restores JSON sessions with alive PID on load", () => {
      const removedIds: string[] = [];
      const inspectManagedProcess = vi.fn(() => true);
      const json = manager.createSession(
        "agent",
        "json",
        "claude",
        "/tmp/test",
        ALIVE_PID,
        "alive",
      );

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isManagedSessionProcess: inspectManagedProcess,
        onSessionRemoved: (id) => removedIds.push(id),
      });
      const restored = manager2.getSession(json.id);
      expect(restored?.name).toBe("alive");
      expect(restored?.mode).toBe("json");
      expect(removedIds).not.toContain(json.id);
      expect(inspectManagedProcess).toHaveBeenCalledWith(
        ALIVE_PID,
        expect.objectContaining({
          id: json.id,
          mode: "json",
          provider: "claude",
          workerSocketPath: expect.stringContaining(json.id),
        }),
      );
      manager2.stopReaper();
    });

    it("cleans an alive JSON record whose worker process identity is unverified", () => {
      const removedIds: string[] = [];
      const terminateManagedSession = vi.fn();
      const json = manager.createSession(
        "agent",
        "json",
        "kimi",
        "/tmp/test",
        ALIVE_PID,
        "unverified",
      );

      const manager2 = new SessionManager({
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        persistPath,
        isProcessAlive: () => true,
        isManagedSessionProcess: () => false,
        terminateManagedSession,
        onSessionRemoved: (id) => removedIds.push(id),
      });

      expect(manager2.getSession(json.id)).toBeUndefined();
      expect(removedIds).toContain(json.id);
      expect(terminateManagedSession).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      manager2.stopReaper();
    });
  });

  describe("PTY binding lifecycle", () => {
    it.each(["pending", "active"] as const)(
      "accepts a Shell cwd change on %s reconnect",
      (binding) => {
        const claim = {
          kind: "terminal" as const,
          provider: "claude" as const,
          ptyOwner: "proxy-hosted" as const,
          cwd: "/tmp/first",
          pid: ALIVE_PID,
        };
        const { session } = manager.claimPtySession(claim);
        if (binding === "pending") manager.releasePtyBinding(session.id, ALIVE_PID);
        const restored = manager.claimPtySession({
          ...claim,
          sessionId: session.id,
          cwd: "/tmp/second",
        });
        expect(restored.source).toBe(binding);
        expect(restored.session.cwd).toBe("/tmp/second");
        expect(JSON.parse(readFileSync(persistPath, "utf-8"))[0].cwd).toBe("/tmp/second");
      },
    );

    it.each([
      { kind: "agent", provider: "claude", ptyOwner: "local-terminal" },
      { kind: "agent", provider: "claude", ptyOwner: "proxy-hosted" },
      { kind: "agent", provider: "codex", ptyOwner: "proxy-hosted" },
      { kind: "agent", provider: "kimi", ptyOwner: "proxy-hosted" },
      { kind: "terminal", provider: "claude", ptyOwner: "proxy-hosted" },
    ] as const)("retains $kind/$provider/$ptyOwner through repeated binding loss", (identity) => {
      const onSessionRemoved = vi.fn();
      manager = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        onSessionRemoved,
      });
      const claim = { ...identity, cwd: "/tmp/project", pid: ALIVE_PID, name: "Project" };
      const created = manager.claimPtySession(claim).session;
      manager.setHistorySessionId(created.id, "native-history");
      manager.setClaudeSessionId(created.id, "native-current");
      manager.renameSession(created.id, "My session");
      const original = { ...manager.getSession(created.id)! };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(manager.releasePtyBinding(created.id, ALIVE_PID + 1)).toBe(false);
        expect(manager.releasePtyBinding(created.id, ALIVE_PID)).toBe(true);
        expect(manager.releasePtyBinding(created.id, ALIVE_PID)).toBe(true);
        expect(manager.listSessions()).toEqual([]);
        expect(manager.getSession(created.id)).toBeUndefined();
        expect(manager.getRuntimeSession(created.id)).toMatchObject({
          ...identity,
          name: original.name,
          nameLocked: true,
          historySessionId: "native-history",
          claudeSessionId: "native-current",
        });
        expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toHaveLength(1);

        const rebound = manager.claimPtySession({ ...claim, sessionId: created.id });
        expect(rebound.source).toBe("pending");
        expect(rebound.session).toEqual(original);
        expect(onSessionRemoved).not.toHaveBeenCalled();
      }
    });

    it("keeps unbound metadata when another session is saved and the Proxy reloads", () => {
      const first = manager.claimPtySession({
        kind: "agent",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/project",
        pid: ALIVE_PID,
        name: "Automatic title",
      }).session;
      manager.releasePtyBinding(first.id, ALIVE_PID);
      manager.createSession("agent", "json", "claude", "/tmp/other", DEAD_PID);
      const restored = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
      });
      const rebound = restored.claimPtySession({
        kind: "agent",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
        cwd: first.cwd,
        pid: first.pid,
        sessionId: first.id,
      });
      expect(rebound.source).toBe("pending");
      expect(rebound.session.name).toBe("Automatic title");
    });

    it("explicitly removes pending PTYs without leaving records to reclaim", () => {
      const onSessionRemoved = vi.fn();
      manager = new SessionManager({
        persistPath,
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        onSessionRemoved,
      });
      const claim = {
        kind: "terminal" as const,
        provider: "claude" as const,
        ptyOwner: "proxy-hosted" as const,
        cwd: "/tmp/project",
        pid: ALIVE_PID,
      };
      const { session } = manager.claimPtySession(claim);
      manager.releasePtyBinding(session.id, ALIVE_PID);
      expect(manager.terminateSession(session.id)).toEqual({ success: true, pid: ALIVE_PID });
      expect(manager.getRuntimeSession(session.id)).toBeUndefined();
      expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
      expect(onSessionRemoved).toHaveBeenCalledExactlyOnceWith(session.id, undefined);
      expect(() => manager.claimPtySession({ ...claim, sessionId: session.id })).toThrow();
      expect(manager.releasePtyBinding(session.id, ALIVE_PID)).toBe(false);
    });

    it("does not release JSON sessions as PTY bindings", () => {
      const session = manager.createSession("agent", "json", "claude", "/tmp", ALIVE_PID);
      expect(manager.releasePtyBinding(session.id, ALIVE_PID)).toBe(false);
      expect(manager.getSession(session.id)).toEqual(session);
    });
  });

  describe("reaper", () => {
    it.each(["EPERM", "EIO"])(
      "does not discard a pending PTY when process inspection returns %s",
      (code) => {
        vi.useFakeTimers();
        const { session } = manager.claimPtySession({
          kind: "agent",
          provider: "kimi",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/project",
          pid: ALIVE_PID,
        });
        manager.releasePtyBinding(session.id, ALIVE_PID);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error(code), { code });
        });
        try {
          manager.startReaper(1_000);
          vi.advanceTimersByTime(1_000);
          expect(manager.getRuntimeSession(session.id)).toBeDefined();
        } finally {
          killSpy.mockRestore();
        }
      },
    );

    it("reaps an active PTY after confirmed owner exit", () => {
      vi.useFakeTimers();
      const { session } = manager.claimPtySession({
        kind: "terminal",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/project",
        pid: DEAD_PID,
      });
      manager.startReaper(1_000);
      vi.advanceTimersByTime(1_000);
      expect(manager.getRuntimeSession(session.id)).toBeUndefined();
    });

    it("removes dead JSON sessions from registry", () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal?) => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      const s = manager.createSession("agent", "json", "claude", "/tmp/test", 99999);
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

      const s = manager.createSession("agent", "json", "claude", "/tmp/test", 99999);
      manager.updateState(s.id, SessionState.WORKING);

      manager.startReaper(1000);
      vi.advanceTimersByTime(1100);

      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("stopReaper clears the interval", () => {
      vi.useFakeTimers();

      const s = manager.createSession("agent", "json", "claude", "/tmp/test", 99999);
      manager.updateState(s.id, SessionState.WORKING);

      manager.startReaper(1000);
      manager.stopReaper();

      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal?) => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      vi.advanceTimersByTime(5000);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);

      killSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
