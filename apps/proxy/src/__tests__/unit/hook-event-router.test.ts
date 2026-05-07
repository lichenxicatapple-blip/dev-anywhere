import { describe, expect, it } from "vitest";
import { MessageEnvelopeSchema, RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { HookEventRouter } from "#src/serve/hook-event-router.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import { createRelayConnectionFake } from "./test-fakes.js";

describe("HookEventRouter", () => {
  it("maps lifecycle hook events to session state", () => {
    const states: Array<[string, SessionState]> = [];
    const relay = createRelayConnectionFake();
    let seq = 0;
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: relay.relayConnection,
      agentStatusRegistry,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
      nextSeq: () => ++seq,
    });

    router.handle({ sessionId: "s1", provider: "claude", event: "SessionStart", payload: {} });
    router.handle({ sessionId: "s1", provider: "claude", event: "UserPromptSubmit", payload: {} });
    router.handle({ sessionId: "s1", provider: "claude", event: "Stop", payload: {} });

    expect(states).toEqual([
      ["s1", SessionState.IDLE],
      ["s1", SessionState.WORKING],
      ["s1", SessionState.IDLE],
    ]);
    const statuses = relay.raw.map((raw) => RelayControlSchema.parse(JSON.parse(raw)));
    expect(statuses.map((msg) => (msg.type === "agent_status" ? msg.payload.phase : ""))).toEqual([
      "idle",
      "thinking",
      "idle",
    ]);
    expect(agentStatusRegistry.get("s1")?.phase).toBe("idle");
  });

  it("emits MessageEnvelope-valid tool_use_request for hook PermissionRequest", () => {
    const relay = createRelayConnectionFake();
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: relay.relayConnection,
      agentStatusRegistry,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
      nextSeq: () => 7,
    });

    router.handle({
      sessionId: "s1",
      provider: "claude",
      event: "PermissionRequest",
      requestId: "req-1",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      },
    });

    expect(states).toEqual([["s1", SessionState.WAITING_APPROVAL]]);
    expect(relay.raw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(relay.raw[0]));
    expect(status.type).toBe("agent_status");
    if (status.type === "agent_status") {
      expect(status.payload).toMatchObject({
        provider: "claude",
        phase: "waiting_permission",
        seq: 7,
        toolName: "Bash",
        toolInput: { command: "pwd" },
        permissionRequest: {
          requestId: "req-1",
          toolName: "Bash",
          input: { command: "pwd" },
        },
      });
      expect(status.payload.updatedAt).toBeTypeOf("number");
    }
    expect(agentStatusRegistry.get("s1")?.phase).toBe("waiting_permission");
    expect(relay.envelopes).toHaveLength(1);
    const parsed = MessageEnvelopeSchema.safeParse(relay.envelopes[0]);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success || parsed.data.type !== "tool_use_request") return;
    expect(parsed.data.seq).toBe(7);
    expect(parsed.data.sessionId).toBe("s1");
    expect(parsed.data.payload).toEqual({
      toolName: "Bash",
      toolId: "req-1",
      parameters: { command: "pwd" },
    });
  });

  it("treats hook PreToolUse as non-blocking tool-use telemetry", () => {
    const relay = createRelayConnectionFake();
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: relay.relayConnection,
      agentStatusRegistry,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
      nextSeq: () => 8,
    });

    router.handle({
      sessionId: "s1",
      provider: "claude",
      event: "PreToolUse",
      requestId: "toolu-1",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      },
    });

    expect(states).toEqual([]);
    expect(relay.raw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(relay.raw[0]));
    expect(status.type).toBe("agent_status");
    if (status.type === "agent_status") {
      expect(status.payload).toMatchObject({
        provider: "claude",
        phase: "tool_use",
        seq: 8,
        toolName: "Bash",
        toolInput: { command: "pwd" },
      });
    }
    expect(relay.envelopes).toHaveLength(0);
  });

  it("emits agent_status when hook permission is resolved", () => {
    const relay = createRelayConnectionFake();
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: relay.relayConnection,
      agentStatusRegistry,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
      nextSeq: () => 9,
    });

    router.onPermissionResolved("s1", "codex", "req-1", "allow", {
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });

    expect(states).toEqual([["s1", SessionState.WORKING]]);
    expect(relay.raw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(relay.raw[0]));
    expect(status.type).toBe("agent_status");
    if (status.type === "agent_status") {
      expect(status.payload).toMatchObject({
        provider: "codex",
        phase: "tool_use",
        seq: 9,
        toolName: "Bash",
        toolInput: { command: "pwd" },
        permissionResolution: {
          requestId: "req-1",
          outcome: "allow",
        },
      });
    }
    expect(agentStatusRegistry.get("s1")?.phase).toBe("tool_use");
  });

  it("returns to idle when hook permission is denied", () => {
    const relay = createRelayConnectionFake();
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: relay.relayConnection,
      agentStatusRegistry,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
      nextSeq: () => 10,
    });

    router.onPermissionResolved("s1", "claude", "req-1", "deny", {
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });

    expect(states).toEqual([
      ["s1", SessionState.WORKING],
      ["s1", SessionState.IDLE],
    ]);
    const status = RelayControlSchema.parse(JSON.parse(relay.raw[0]));
    expect(status.type).toBe("agent_status");
    if (status.type === "agent_status") {
      expect(status.payload).toMatchObject({
        provider: "claude",
        phase: "idle",
        permissionResolution: {
          requestId: "req-1",
          outcome: "deny",
        },
      });
    }
    expect(agentStatusRegistry.get("s1")?.phase).toBe("idle");
  });
});
