import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import {
  isRouteSessionEnded,
  resolveChatPresentation,
  resolveChatStatusState,
  shouldShowPtyApprovalHint,
} from "./chat-status";
import { useChatCommandSession } from "./use-chat-command-session";
import { useCommandStore } from "@/stores/command-store";

const baseSession: SessionInfo = {
  sessionId: "s1",
  kind: "agent",
  mode: "pty",
  provider: "claude",
  state: "idle",
  ptyOwner: "proxy-hosted",
  cwd: "/tmp/project",
  lastActive: 1,
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
        ptyState: { state: "approval_wait", seq: 1, tool: "Write" },
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
        ptyState: { state: "approval_wait", seq: 1, tool: "Write" },
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

  it("shows an error presentation for a live session whose worker channel failed", () => {
    expect(
      resolveChatPresentation({
        connected: true,
        proxyOnline: true,
        routeSessionEnded: false,
        sessionState: "error",
      }),
    ).toBe("session-error");
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

describe("ChatPage command session projection", () => {
  beforeEach(() => {
    useCommandStore.setState(useCommandStore.getInitialState(), true);
    useCommandStore
      .getState()
      .setSessionCommands("s1", [{ name: "/one", description: "one", source: "test" }]);
    useCommandStore
      .getState()
      .setSessionCommands("s2", [{ name: "/two", description: "two", source: "test" }]);
  });

  it("selects the matching command cache when the chat route changes", () => {
    const view = renderHook(
      ({ sessionId }: { sessionId: string }) => useChatCommandSession(sessionId),
      { initialProps: { sessionId: "s1" } },
    );

    expect(useCommandStore.getState().activeSessionId).toBe("s1");
    expect(useCommandStore.getState().commands[0].name).toBe("/one");

    view.rerender({ sessionId: "s2" });
    expect(useCommandStore.getState().activeSessionId).toBe("s2");
    expect(useCommandStore.getState().commands[0].name).toBe("/two");

    view.unmount();
    expect(useCommandStore.getState().activeSessionId).toBeNull();
  });

  it("does not let a stale chat cleanup clear a newer active session", () => {
    const view = renderHook(() => useChatCommandSession("s1"));

    act(() => useCommandStore.getState().setActiveSession("s2"));
    view.unmount();

    expect(useCommandStore.getState().activeSessionId).toBe("s2");
    expect(useCommandStore.getState().commands[0].name).toBe("/two");
  });
});
