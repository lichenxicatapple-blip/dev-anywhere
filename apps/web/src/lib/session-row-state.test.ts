import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import { resolveSessionRowState } from "./session-row-state";

const jsonSession: SessionInfo = {
  sessionId: "json-sess",
  mode: "json",
  provider: "claude",
  state: "working",
};

function agentStatus(phase: AgentStatusPayload["phase"]): AgentStatusPayload {
  return {
    provider: "claude",
    phase,
    seq: 1,
    updatedAt: 1,
  };
}

describe("resolveSessionRowState", () => {
  it("shows waiting approval above a working JSON session when an approval is pending", () => {
    expect(
      resolveSessionRowState({
        session: jsonSession,
        agentStatus: agentStatus("tool_use"),
        ptyState: undefined,
        hasPendingApproval: true,
      }),
    ).toBe("waiting_approval");
  });

  it("preserves explicit error state for sidebar rows", () => {
    expect(
      resolveSessionRowState({
        session: { ...jsonSession, state: "error" },
        agentStatus: agentStatus("tool_use"),
        ptyState: undefined,
        hasPendingApproval: true,
      }),
    ).toBe("error");
  });
});
