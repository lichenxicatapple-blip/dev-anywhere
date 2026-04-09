import { describe, it, expect } from "vitest";
import {
  SessionListPayloadSchema,
  SessionSwitchPayloadSchema,
  SessionTerminatePayloadSchema,
  SessionStatusPayloadSchema,
} from "../session.js";

describe("SessionListPayloadSchema", () => {
  it("accepts valid session list", () => {
    const result = SessionListPayloadSchema.parse({
      sessions: [
        { sessionId: "s1", name: "sess1", state: "idle" },
        { sessionId: "s2", state: "working" },
      ],
    });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].name).toBe("sess1");
    expect(result.sessions[1].name).toBeUndefined();
  });

  it("accepts empty session list", () => {
    const result = SessionListPayloadSchema.parse({ sessions: [] });
    expect(result.sessions).toEqual([]);
  });

  it("rejects invalid session state", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [{ sessionId: "s1", state: "invalid_state" }],
      }),
    ).toThrow();
  });

  it("accepts all valid session states", () => {
    const states = [
      "idle",
      "working",
      "waiting_approval",
      "error",
      "terminated",
    ] as const;
    for (const state of states) {
      const result = SessionListPayloadSchema.parse({
        sessions: [{ sessionId: "s1", state }],
      });
      expect(result.sessions[0].state).toBe(state);
    }
  });

  it("rejects missing sessions field", () => {
    expect(() => SessionListPayloadSchema.parse({})).toThrow();
  });
});

describe("SessionSwitchPayloadSchema", () => {
  it("rejects missing sessionId", () => {
    expect(() => SessionSwitchPayloadSchema.parse({})).toThrow();
  });
});

describe("SessionTerminatePayloadSchema", () => {
  it("rejects missing sessionId", () => {
    expect(() => SessionTerminatePayloadSchema.parse({})).toThrow();
  });
});

describe("SessionStatusPayloadSchema", () => {
  it("rejects invalid state", () => {
    expect(() =>
      SessionStatusPayloadSchema.parse({
        sessionId: "s1",
        state: "unknown",
      }),
    ).toThrow();
  });

  it("rejects missing state", () => {
    expect(() =>
      SessionStatusPayloadSchema.parse({ sessionId: "s1" }),
    ).toThrow();
  });
});
