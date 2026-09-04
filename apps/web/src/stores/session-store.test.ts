import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { ptyAutoYesSessionKey, useSessionStore } from "./session-store";

describe("session-store agent status", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useSessionStore.setState({
      sessions: [],
      sessionListLoaded: false,
      loadingProxyName: null,
      historySessions: [],
      historyLoadStatus: "idle",
      historyLoadGeneration: 0,
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
      ptyAutoYesBySessionKey: {},
    });
  });

  it("keeps the newest agent status per session by seq", () => {
    useSessionStore.getState().setAgentStatus("s1", {
      provider: "claude",
      phase: "thinking",
      seq: 2,
      updatedAt: 100,
    });
    useSessionStore.getState().setAgentStatus("s1", {
      provider: "claude",
      phase: "idle",
      seq: 1,
      updatedAt: 90,
    });

    expect(useSessionStore.getState().agentStatusBySessionId.s1.phase).toBe("thinking");
  });

  it("prunes agent status when replacing the session list", () => {
    useSessionStore.getState().setAgentStatus("s1", {
      provider: "claude",
      phase: "thinking",
      seq: 1,
      updatedAt: 100,
    });
    useSessionStore.getState().setAgentStatus("s2", {
      provider: "codex",
      phase: "waiting_permission",
      seq: 1,
      updatedAt: 100,
    });

    useSessionStore.getState().setSessions([
      {
        sessionId: "s2",
        kind: "agent",
        state: "working",
        mode: "json",
        provider: "codex",
        cwd: "/tmp/project",
        lastActive: 1,
      },
    ]);

    expect(useSessionStore.getState().agentStatusBySessionId.s1).toBeUndefined();
    expect(useSessionStore.getState().agentStatusBySessionId.s2.phase).toBe("waiting_permission");
  });

  it("prunes PTY semantic state when replacing the session list", () => {
    useSessionStore.getState().setPtyState("s1", {
      state: "approval_wait",
      seq: 1,
      tool: "Write",
    });
    useSessionStore.getState().setPtyState("s2", { state: "working", seq: 1 });

    useSessionStore.getState().setSessions([
      {
        sessionId: "s2",
        kind: "agent",
        state: "working",
        provider: "claude",
        mode: "pty",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/project",
        lastActive: 1,
      },
    ]);

    expect(useSessionStore.getState().ptyStateBySessionId.s1).toBeUndefined();
    expect(useSessionStore.getState().ptyStateBySessionId.s2.state).toBe("working");
  });

  it("keeps the newest PTY semantic state per session by seq", () => {
    useSessionStore.getState().setPtyState("s1", { state: "approval_wait", seq: 2, tool: "Bash" });
    useSessionStore.getState().setPtyState("s1", { state: "approval_wait", seq: 1, tool: "Write" });

    expect(useSessionStore.getState().ptyStateBySessionId.s1).toMatchObject({
      state: "approval_wait",
      seq: 2,
      tool: "Bash",
    });
  });

  it("prunes PTY titles when replacing or removing sessions", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          state: "idle",
          provider: "claude",
          mode: "pty",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/project",
          lastActive: 1,
        },
        {
          sessionId: "s2",
          kind: "agent",
          state: "idle",
          provider: "codex",
          mode: "pty",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
      ptyTitles: { s1: "old title", s2: "live title" },
    });

    useSessionStore.getState().setSessions([
      {
        sessionId: "s2",
        kind: "agent",
        state: "working",
        provider: "codex",
        mode: "pty",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/project",
        lastActive: 1,
      },
    ]);

    expect(useSessionStore.getState().ptyTitles).toEqual({ s2: "live title" });

    useSessionStore.getState().removeSession("s2");

    expect(useSessionStore.getState().ptyTitles).toEqual({});
  });

  it("marks renamed sessions as user locked without deleting OSC title diagnostics", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
          state: "idle",
          name: "~/project",
          cwd: "/Users/dev/project",
          lastActive: 1,
        },
      ],
      ptyTitles: { s1: "✻ Working" },
    });

    useSessionStore.getState().renameSession("s1", "Release checklist");

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      sessionId: "s1",
      name: "Release checklist",
      nameLocked: true,
      cwd: "/Users/dev/project",
    });
    expect(useSessionStore.getState().ptyTitles.s1).toBe("✻ Working");
  });

  it("keeps PTY auto-yes scoped to proxy/session across list replacement and clears it on removal", () => {
    const sessionKey = ptyAutoYesSessionKey("proxy-a", "s1");
    const otherProxySessionKey = ptyAutoYesSessionKey("proxy-b", "s1");
    if (!sessionKey || !otherProxySessionKey) throw new Error("missing session key");

    useSessionStore.getState().setPtyAutoYes(sessionKey, true);
    useSessionStore.getState().setPtyAutoYes(otherProxySessionKey, true);
    useSessionStore.getState().setSessions([
      {
        sessionId: "s2",
        kind: "agent",
        state: "working",
        provider: "codex",
        mode: "pty",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/project",
        lastActive: 1,
      },
    ]);

    expect(useSessionStore.getState().ptyAutoYesBySessionKey).toEqual({
      [sessionKey]: true,
      [otherProxySessionKey]: true,
    });
    expect(sessionStorage.getItem(STORAGE_KEYS.ptyAutoYesSessions)).toContain(sessionKey);

    useSessionStore.getState().removeSession("s1");

    expect(useSessionStore.getState().ptyAutoYesBySessionKey).toEqual({});
    expect(sessionStorage.getItem(STORAGE_KEYS.ptyAutoYesSessions)).toBeNull();
  });

  it("clears proxy-scoped session data while preserving per-proxy auto-yes during a switch", () => {
    const sessionKey = ptyAutoYesSessionKey("proxy-a", "s1");
    if (!sessionKey) throw new Error("missing session key");
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          state: "idle",
          provider: "claude",
          mode: "pty",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
      sessionListLoaded: true,
      historySessions: [
        {
          id: "history-1",
          title: "Old history",
          projectDir: "/old",
          updatedAt: 1,
          provider: "claude",
        },
      ],
      ptyTitles: { s1: "Old title" },
      ptyStateBySessionId: { s1: { state: "working", seq: 1 } },
      agentStatusBySessionId: {
        s1: { provider: "claude", phase: "thinking", seq: 1, updatedAt: 1 },
      },
      ptyAutoYesBySessionKey: { [sessionKey]: true },
    });

    useSessionStore.getState().prepareForProxySwitch("Slow Mac");

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      sessionListLoaded: false,
      loadingProxyName: "Slow Mac",
      historySessions: [],
      historyLoadStatus: "idle",
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
      ptyAutoYesBySessionKey: { [sessionKey]: true },
    });

    useSessionStore.getState().setSessions([
      {
        sessionId: "s2",
        kind: "agent",
        state: "idle",
        provider: "codex",
        mode: "json",
        cwd: "/tmp/project",
        lastActive: 1,
      },
    ]);

    expect(useSessionStore.getState().loadingProxyName).toBeNull();
    expect(useSessionStore.getState().sessionListLoaded).toBe(true);
  });

  it("clears only the removed proxy's temporary auto-yes grants when forgetting a device", () => {
    const removedKey = ptyAutoYesSessionKey("proxy-a", "s1");
    const retainedKey = ptyAutoYesSessionKey("proxy-b", "s2");
    if (!removedKey || !retainedKey) throw new Error("missing session key");
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          state: "idle",
          provider: "claude",
          mode: "pty",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/project",
          lastActive: 1,
        },
      ],
      sessionListLoaded: true,
      loadingProxyName: "Old Mac",
      ptyAutoYesBySessionKey: { [removedKey]: true, [retainedKey]: true },
    });

    useSessionStore.getState().clearForProxyRemoval("proxy-a");

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      sessionListLoaded: false,
      loadingProxyName: null,
      ptyAutoYesBySessionKey: { [retainedKey]: true },
    });
    expect(sessionStorage.getItem(STORAGE_KEYS.ptyAutoYesSessions)).not.toContain(removedKey);
    expect(sessionStorage.getItem(STORAGE_KEYS.ptyAutoYesSessions)).toContain(retainedKey);
  });
});
