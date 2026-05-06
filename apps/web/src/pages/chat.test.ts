import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import { isRouteSessionEnded, resolveChatStatusState } from "./chat-status";

const baseSession: SessionInfo = {
  sessionId: "s1",
  mode: "pty",
  provider: "claude",
  state: "idle",
};

function status(overrides: Partial<AgentStatusPayload>): AgentStatusPayload {
  return {
    provider: "claude",
    seq: 1,
    phase: "idle",
    updatedAt: 1,
    ...overrides,
  };
}

describe("ChatPage session lifecycle derivation", () => {
  it("does not treat a missing session as ended before the session list loads", () => {
    expect(isRouteSessionEnded(undefined, false)).toBe(false);
  });

  it("treats a missing current route session as ended after the active list loads", () => {
    expect(isRouteSessionEnded(undefined, true)).toBe(true);
  });

  it("shows terminated when the current route session disappeared from the active list", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: true,
        session: undefined,
        agentStatus: status({ phase: "tool_use" }),
        hasPendingApproval: true,
      }),
    ).toBe("terminated");
  });

  it("keeps disconnected above terminated because the proxy state is unknown", () => {
    expect(
      resolveChatStatusState({
        connected: false,
        proxyOnline: true,
        routeSessionEnded: true,
        session: undefined,
        agentStatus: undefined,
        hasPendingApproval: false,
      }),
    ).toBe("disconnected");
  });

  it("keeps normal active sessions on their provider/status state", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        session: baseSession,
        agentStatus: status({ phase: "tool_use" }),
        hasPendingApproval: false,
      }),
    ).toBe("working");
  });
});
