import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { MessageEnvelopeSchema, SessionState } from "@dev-anywhere/shared";
import { HookEventRouter } from "#src/serve/hook-event-router.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

describe("HookEventRouter", () => {
  it("maps lifecycle hook events to session state", () => {
    const states: Array<[string, SessionState]> = [];
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: () => {},
      }) as unknown as RelayConnection,
      changeSessionState: (sessionId, state) => {
        states.push([sessionId, state]);
        return true;
      },
    });

    router.handle({ sessionId: "s1", provider: "claude", event: "SessionStart", payload: {} });
    router.handle({ sessionId: "s1", provider: "claude", event: "UserPromptSubmit", payload: {} });
    router.handle({ sessionId: "s1", provider: "claude", event: "Stop", payload: {} });

    expect(states).toEqual([
      ["s1", SessionState.IDLE],
      ["s1", SessionState.WORKING],
      ["s1", SessionState.IDLE],
    ]);
  });

  it("emits MessageEnvelope-valid tool_use_request for hook PermissionRequest", () => {
    const captured: unknown[] = [];
    const states: Array<[string, SessionState]> = [];
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: (env: unknown) => captured.push(env),
      }) as unknown as RelayConnection,
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
    const states: Array<[string, SessionState]> = [];
    const router = new HookEventRouter({
      relayConnection: Object.assign(new EventEmitter(), {
        sendEnvelope: (env: unknown) => captured.push(env),
      }) as unknown as RelayConnection,
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
});
