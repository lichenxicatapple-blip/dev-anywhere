import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import {
  isRouteSessionEnded,
  resolveChatPresentation,
  resolveChatStatusState,
  shouldShowPtyApprovalHint,
} from "./chat-status";

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
        ptyState: { state: "approval_wait", tool: "Write" },
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
        ptyState: undefined,
        hasPendingApproval: false,
      }),
    ).toBe("disconnected");
  });

  it("keeps server idle state authoritative over stale provider/status state", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        session: baseSession,
        agentStatus: status({ phase: "tool_use" }),
        ptyState: undefined,
        hasPendingApproval: false,
      }),
    ).toBe("idle");
  });

  it("keeps server idle state authoritative over stale PTY approval state", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        session: baseSession,
        agentStatus: undefined,
        ptyState: { state: "approval_wait", tool: "Write" },
        hasPendingApproval: false,
      }),
    ).toBe("idle");
  });

  it("restores approval wait from the server session state after refresh", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        session: { ...baseSession, state: "waiting_approval" },
        agentStatus: undefined,
        ptyState: undefined,
        hasPendingApproval: false,
      }),
    ).toBe("waiting_approval");
  });

  it("does not let JSON approval queue alone drive PTY status", () => {
    expect(
      resolveChatStatusState({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        session: baseSession,
        agentStatus: undefined,
        ptyState: undefined,
        hasPendingApproval: false,
      }),
    ).toBe("idle");
  });
});

describe("resolveChatPresentation", () => {
  it("renders chat content when relay + proxy are up and session is alive", () => {
    expect(
      resolveChatPresentation({ connected: true, proxyOnline: true, routeSessionEnded: false }),
    ).toBe("ok");
  });

  it("flags relay-disconnected when client websocket is down regardless of proxy state", () => {
    expect(
      resolveChatPresentation({ connected: false, proxyOnline: true, routeSessionEnded: false }),
    ).toBe("relay-disconnected");
  });

  it("does not downgrade to proxy-offline if relay itself is down (proxy state unknown)", () => {
    expect(
      resolveChatPresentation({ connected: false, proxyOnline: false, routeSessionEnded: true }),
    ).toBe("relay-disconnected");
  });

  it("flags proxy-offline when relay is up but the dev-machine proxy is not online", () => {
    expect(
      resolveChatPresentation({ connected: true, proxyOnline: false, routeSessionEnded: false }),
    ).toBe("proxy-offline");
  });

  it("flags session-ended only after both relay and proxy are confirmed up", () => {
    expect(
      resolveChatPresentation({ connected: true, proxyOnline: true, routeSessionEnded: true }),
    ).toBe("session-ended");
  });
});

describe("shouldShowPtyApprovalHint", () => {
  it("hides the PTY approval banner after Always yes is enabled", () => {
    expect(shouldShowPtyApprovalHint({ ptyWaitingApproval: true, ptyAutoYesEnabled: false })).toBe(
      true,
    );
    expect(shouldShowPtyApprovalHint({ ptyWaitingApproval: true, ptyAutoYesEnabled: true })).toBe(
      false,
    );
  });
});
