import { describe, expect, it } from "vitest";
import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
import { resolveSessionDisplayState } from "./session-display-state";

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
      name: "session idle is authoritative over stale agent waiting_permission",
      input: {
        session: { ...ptySession, state: "idle" },
        agentStatus: agentStatus("waiting_permission"),
      },
      expected: "idle",
    },
    {
      name: "session idle is authoritative over stale pty approval_wait",
      input: {
        session: { ...ptySession, state: "idle" },
        ptyState: { state: "approval_wait" } satisfies PtyStatePayload,
      },
      expected: "idle",
    },
    {
      name: "session idle is authoritative over stale provider thinking",
      input: {
        session: { ...ptySession, state: "idle" },
        agentStatus: agentStatus("thinking"),
      },
      expected: "idle",
    },
    {
      name: "session idle is authoritative over stale pty working",
      input: {
        session: { ...ptySession, state: "idle" },
        ptyState: { state: "working" } satisfies PtyStatePayload,
      },
      expected: "idle",
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

  it("uses pending approval count above provider working phases", () => {
    expect(
      resolveSessionDisplayState({
        session: ptySession,
        ptyState: { state: "approval_wait" },
        agentStatus: agentStatus("tool_use"),
        hasPendingApproval: true,
      }),
    ).toBe("waiting_approval");
  });

  it("derives waiting approval from server session state", () => {
    expect(
      resolveSessionDisplayState({
        session: { ...ptySession, state: "waiting_approval" },
        agentStatus: agentStatus("tool_use"),
        ptyState: undefined,
      }),
    ).toBe("waiting_approval");
  });
});
