import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "./session-store";

describe("session-store agent status", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      sessionListLoaded: false,
      historySessions: [],
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
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

    useSessionStore
      .getState()
      .setSessions([{ sessionId: "s2", state: "working", provider: "codex" }]);

    expect(useSessionStore.getState().agentStatusBySessionId.s1).toBeUndefined();
    expect(useSessionStore.getState().agentStatusBySessionId.s2.phase).toBe("waiting_permission");
  });

  it("prunes PTY semantic state when replacing the session list", () => {
    useSessionStore.getState().setPtyState("s1", { state: "approval_wait", tool: "Write" });
    useSessionStore.getState().setPtyState("s2", { state: "working" });

    useSessionStore
      .getState()
      .setSessions([{ sessionId: "s2", state: "working", provider: "claude", mode: "pty" }]);

    expect(useSessionStore.getState().ptyStateBySessionId.s1).toBeUndefined();
    expect(useSessionStore.getState().ptyStateBySessionId.s2.state).toBe("working");
  });

  it("prunes PTY titles when replacing or removing sessions", () => {
    useSessionStore.setState({
      sessions: [
        { sessionId: "s1", state: "idle", provider: "claude", mode: "pty" },
        { sessionId: "s2", state: "idle", provider: "codex", mode: "pty" },
      ],
      ptyTitles: { s1: "old title", s2: "live title" },
    });

    useSessionStore
      .getState()
      .setSessions([{ sessionId: "s2", state: "working", provider: "codex", mode: "pty" }]);

    expect(useSessionStore.getState().ptyTitles).toEqual({ s2: "live title" });

    useSessionStore.getState().removeSession("s2");

    expect(useSessionStore.getState().ptyTitles).toEqual({});
  });

  it("marks renamed sessions as user locked without deleting OSC title diagnostics", () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "s1",
          mode: "pty",
          provider: "claude",
          state: "idle",
          name: "~/project",
          cwd: "/Users/dev/project",
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
});
