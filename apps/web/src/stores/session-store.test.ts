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
});
