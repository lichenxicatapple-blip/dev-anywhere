import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
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
  it.each([
    {
      name: "disconnected beats local working signals",
      input: {
        connected: false,
        session: { ...ptySession, state: "working" },
        ptyState: { state: "approval_wait" } satisfies PtyStatePayload,
        agentStatus: agentStatus("tool_use"),
      },
      expected: "disconnected",
    },
    {
      name: "terminated beats pending approval",
      input: {
        routeSessionEnded: true,
        session: { ...ptySession, state: "waiting_approval" },
        ptyState: { state: "approval_wait" } satisfies PtyStatePayload,
        agentStatus: agentStatus("waiting_permission"),
      },
      expected: "terminated",
    },
    {
      name: "pending approval beats provider working",
      input: {
        session: { ...ptySession, state: "working" },
        ptyState: { state: "working" } satisfies PtyStatePayload,
        agentStatus: agentStatus("tool_use"),
        hasPendingApproval: true,
      },
      expected: "waiting_approval",
    },
    {
      name: "agent waiting_permission is approval",
      input: {
        session: { ...ptySession, state: "idle" },
        agentStatus: agentStatus("waiting_permission"),
      },
      expected: "waiting_approval",
    },
    {
      name: "pty approval_wait is approval",
      input: {
        session: { ...ptySession, state: "idle" },
        ptyState: { state: "approval_wait" } satisfies PtyStatePayload,
      },
      expected: "waiting_approval",
    },
    {
      name: "provider thinking is working",
      input: {
        session: { ...ptySession, state: "idle" },
        agentStatus: agentStatus("thinking"),
      },
      expected: "working",
    },
    {
      name: "pty mid_pause is working",
      input: {
        session: { ...ptySession, state: "idle" },
        ptyState: { state: "mid_pause" } satisfies PtyStatePayload,
      },
      expected: "working",
    },
    {
      name: "session working is working",
      input: {
        session: { ...ptySession, state: "working" },
      },
      expected: "working",
    },
    {
      name: "idle when no higher-priority signal exists",
      input: {
        session: ptySession,
        ptyState: { state: "turn_complete" } satisfies PtyStatePayload,
        agentStatus: agentStatus("idle"),
      },
      expected: "idle",
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(
      resolveSessionDisplayState({
        agentStatus: undefined,
        ptyState: undefined,
        ...input,
      }),
    ).toBe(expected);
  });

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
