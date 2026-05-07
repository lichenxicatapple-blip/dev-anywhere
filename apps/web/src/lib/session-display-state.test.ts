import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import { applyDisplayStateToSession, resolveSessionDisplayState } from "./session-display-state";

const ptySession: SessionInfo = {
  sessionId: "s1",
  mode: "pty",
  provider: "codex",
  state: "idle",
};

function agentStatus(phase: AgentStatusPayload["phase"]): AgentStatusPayload {
  return {
    provider: "codex",
    phase,
    seq: 1,
    updatedAt: 1,
  };
}

describe("session display state", () => {
  it("keeps approval above provider working phases", () => {
    expect(
      resolveSessionDisplayState({
        session: ptySession,
        ptyState: { state: "approval_wait" },
        agentStatus: agentStatus("tool_use"),
      }),
    ).toBe("waiting_approval");
  });

  it("applies the same display state used by chat to PTY session rows", () => {
    const displayState = resolveSessionDisplayState({
      session: ptySession,
      ptyState: { state: "approval_wait" },
      agentStatus: agentStatus("tool_use"),
    });

    expect(applyDisplayStateToSession(ptySession, displayState).state).toBe("waiting_approval");
  });

  it("does not rewrite JSON session rows from transient PTY display state", () => {
    const jsonSession: SessionInfo = { ...ptySession, mode: "json", state: "working" };

    expect(applyDisplayStateToSession(jsonSession, "waiting_approval")).toBe(jsonSession);
  });
});
