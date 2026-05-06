import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { MessageEnvelopeSchema, RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { HookEventRouter } from "#src/serve/hook-event-router.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";

describe("HookEventRouter", () => {
  it("maps lifecycle hook events to session state", () => {
    const states: Array<[string, SessionState]> = [];
    const capturedRaw: string[] = [];
    let seq = 0;
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: () => {},
        sendRaw: (raw: string) => capturedRaw.push(raw),
      }) as unknown as RelayConnection,
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
    const statuses = capturedRaw.map((raw) => RelayControlSchema.parse(JSON.parse(raw)));
    expect(statuses.map((msg) => (msg.type === "agent_status" ? msg.payload.phase : ""))).toEqual([
      "idle",
      "thinking",
      "idle",
    ]);
    expect(agentStatusRegistry.get("s1")?.phase).toBe("idle");
  });

  it("emits MessageEnvelope-valid tool_use_request for hook PermissionRequest", () => {
    const captured: unknown[] = [];
    const capturedRaw: string[] = [];
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: (env: unknown) => captured.push(env),
        sendRaw: (raw: string) => capturedRaw.push(raw),
      }) as unknown as RelayConnection,
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
    expect(capturedRaw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(capturedRaw[0]));
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
    expect(captured).toHaveLength(1);
    const parsed = MessageEnvelopeSchema.safeParse(captured[0]);
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

  it("emits MessageEnvelope-valid tool_use_request for hook PreToolUse", () => {
    const captured: unknown[] = [];
    const capturedRaw: string[] = [];
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: (env: unknown) => captured.push(env),
        sendRaw: (raw: string) => capturedRaw.push(raw),
      }) as unknown as RelayConnection,
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

    expect(states).toEqual([["s1", SessionState.WAITING_APPROVAL]]);
    expect(capturedRaw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(capturedRaw[0]));
    expect(status.type).toBe("agent_status");
    if (status.type === "agent_status") {
      expect(status.payload).toMatchObject({
        provider: "claude",
        phase: "waiting_permission",
        seq: 8,
        permissionRequest: {
          requestId: "toolu-1",
          toolName: "Bash",
          input: { command: "pwd" },
        },
      });
    }
    expect(captured).toHaveLength(1);
    const parsed = MessageEnvelopeSchema.safeParse(captured[0]);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success || parsed.data.type !== "tool_use_request") return;
    expect(parsed.data.seq).toBe(8);
    expect(parsed.data.sessionId).toBe("s1");
    expect(parsed.data.payload).toEqual({
      toolName: "Bash",
      toolId: "toolu-1",
      parameters: { command: "pwd" },
    });
  });

  it("emits agent_status when hook permission is resolved", () => {
    const capturedRaw: string[] = [];
    const states: Array<[string, SessionState]> = [];
    const agentStatusRegistry = new AgentStatusRegistry();
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: () => {},
        sendRaw: (raw: string) => capturedRaw.push(raw),
      }) as unknown as RelayConnection,
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
    expect(capturedRaw).toHaveLength(1);
    const status = RelayControlSchema.parse(JSON.parse(capturedRaw[0]));
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
});
