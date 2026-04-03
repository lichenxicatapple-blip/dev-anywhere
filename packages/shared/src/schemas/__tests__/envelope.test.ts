import { describe, it, expect } from "vitest";
import { MessageEnvelopeSchema } from "../envelope.js";

// 辅助函数：创建一个基础的 envelope 结构
function makeEnvelope(
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    seq: 0,
    sessionId: "test-session",
    timestamp: Date.now(),
    source: "proxy",
    version: "1.0",
    type,
    payload,
    ...overrides,
  };
}

describe("MessageEnvelopeSchema", () => {
  describe("chat messages", () => {
    it("validates user_input", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("user_input", { text: "hello" }),
      );
      expect(result.type).toBe("user_input");
      expect(result.payload).toEqual({ text: "hello" });
    });

    it("validates assistant_message", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("assistant_message", {
          text: "response",
          isPartial: false,
        }),
      );
      expect(result.type).toBe("assistant_message");
    });

    it("validates thinking", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("thinking", { text: "hmm..." }),
      );
      expect(result.type).toBe("thinking");
    });
  });

  describe("tool messages", () => {
    it("validates tool_use_request", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("tool_use_request", {
          toolName: "read_file",
          toolId: "t1",
          parameters: { path: "/foo" },
        }),
      );
      expect(result.type).toBe("tool_use_request");
    });

    it("validates tool_approve", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("tool_approve", { toolId: "t1" }),
      );
      expect(result.type).toBe("tool_approve");
    });

    it("validates tool_deny", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("tool_deny", { toolId: "t1", reason: "unsafe" }),
      );
      expect(result.type).toBe("tool_deny");
    });

    it("validates tool_result", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("tool_result", {
          toolId: "t1",
          result: "done",
          isError: false,
        }),
      );
      expect(result.type).toBe("tool_result");
    });
  });

  describe("session messages", () => {
    it("validates session_create", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("session_create", { name: "test" }),
      );
      expect(result.type).toBe("session_create");
    });

    it("validates session_list", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("session_list", {
          sessions: [{ sessionId: "s1", state: "idle" }],
        }),
      );
      expect(result.type).toBe("session_list");
    });

    it("validates session_switch", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("session_switch", { sessionId: "s1" }),
      );
      expect(result.type).toBe("session_switch");
    });

    it("validates session_terminate", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("session_terminate", { sessionId: "s1" }),
      );
      expect(result.type).toBe("session_terminate");
    });

    it("validates session_status", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("session_status", {
          sessionId: "s1",
          state: "working",
        }),
      );
      expect(result.type).toBe("session_status");
    });
  });

  describe("system messages", () => {
    it("validates heartbeat", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("heartbeat", {}),
      );
      expect(result.type).toBe("heartbeat");
    });

    it("validates error", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("error", { code: "UNKNOWN", message: "something" }),
      );
      expect(result.type).toBe("error");
    });

    it("validates auth", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("auth", { pairingCode: "123456" }),
      );
      expect(result.type).toBe("auth");
    });

    it("validates sync_request", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("sync_request", { lastSeq: 5 }),
      );
      expect(result.type).toBe("sync_request");
    });

    it("validates sync_response", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("sync_response", { messages: [] }),
      );
      expect(result.type).toBe("sync_response");
    });
  });

  describe("envelope field validation", () => {
    it("rejects missing seq", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).seq;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects missing sessionId", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).sessionId;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects missing timestamp", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).timestamp;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects missing source", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).source;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects missing version", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).version;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects negative seq", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeEnvelope("heartbeat", {}, { seq: -1 })),
      ).toThrow();
    });

    it("rejects invalid source", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("heartbeat", {}, { source: "invalid" }),
        ),
      ).toThrow();
    });

    it("accepts client as source", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("heartbeat", {}, { source: "client" }),
      );
      expect(result.source).toBe("client");
    });
  });

  describe("invalid messages", () => {
    it("rejects unknown message type", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("unknown_type", { data: 1 }),
        ),
      ).toThrow();
    });

    it("rejects mismatched payload for type", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("user_input", { wrong: "field" }),
        ),
      ).toThrow();
    });
  });
});
