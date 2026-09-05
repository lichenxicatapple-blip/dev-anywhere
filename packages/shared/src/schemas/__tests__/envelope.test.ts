import { describe, it, expect } from "vitest";
import { MessageEnvelopeSchema } from "../envelope.js";
import { PtyStatePayloadSchema, SessionListPayloadSchema } from "../session.js";

// 辅助函数：创建一个基础的 envelope 结构
function makeEnvelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    seq: 0,
    timestamp: Date.now(),
    source: "proxy",
    version: "1.0",
    type,
    payload,
    ...overrides,
  };
}

function makeSessionEnvelope(
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) {
  return makeEnvelope(type, payload, { sessionId: "test-session", ...overrides });
}

describe("MessageEnvelopeSchema", () => {
  describe("envelope field validation", () => {
    it("rejects missing seq", () => {
      const env = makeEnvelope("heartbeat", {});
      delete (env as Record<string, unknown>).seq;
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("rejects missing sessionId on session-scoped envelope", () => {
      // session_status 是 session-scoped, 必须带 sessionId; heartbeat / session_list 等
      // 全局广播则允许省略——schema 按 type 区分。
      const env = makeEnvelope("session_status", {
        sessionId: "s1",
        state: "idle",
        lastActive: 0,
      });
      expect(() => MessageEnvelopeSchema.parse(env)).toThrow();
    });

    it("allows missing sessionId on global broadcast envelope", () => {
      const env = makeEnvelope("heartbeat", {});
      expect(() => MessageEnvelopeSchema.parse(env)).not.toThrow();
    });

    it.each([
      ["heartbeat", {}],
      ["session_list", { sessions: [] }],
      ["sync_response", { messages: [] }],
    ])("rejects sessionId on the global %s envelope", (type, payload) => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope(type, payload, { sessionId: "unexpected-session-scope" }),
        ),
      ).toThrow();
    });

    it("rejects unknown top-level fields on an operation envelope", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeSessionEnvelope("user_input", { text: "hello" }, { proxyId: "unexpected" }),
        ),
      ).toThrow();
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

    it("rejects a non-current version", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeEnvelope("heartbeat", {}, { version: "0.9" })),
      ).toThrow();
    });

    it("rejects negative seq", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeEnvelope("heartbeat", {}, { seq: -1 })),
      ).toThrow();
    });

    it("rejects invalid source", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeEnvelope("heartbeat", {}, { source: "invalid" })),
      ).toThrow();
    });

    it("accepts client as source", () => {
      const result = MessageEnvelopeSchema.parse(
        makeEnvelope("heartbeat", {}, { source: "client" }),
      );
      expect(result.source).toBe("client");
    });
  });

  describe("descriptive extensions", () => {
    it.each([
      ["assistant_message", { turnId: "turn-1", revision: 1, text: "hello", status: "completed" }],
      ["thinking", { text: "reasoning" }],
      [
        "tool_use_request",
        { toolId: "tool-1", toolName: "Read", parameters: { path: "README.md" } },
      ],
      [
        "assistant_tool_use",
        { toolId: "tool-1", toolName: "Read", parameters: { path: "README.md" } },
      ],
      ["tool_result", { toolId: "tool-1", result: { content: "read result" }, isError: false }],
      ["session_status", { sessionId: "test-session", state: "idle", lastActive: 1 }],
    ])("strips extra envelope and payload descriptions from %s", (type, payload) => {
      const expected = makeSessionEnvelope(type, payload);
      const parsed = MessageEnvelopeSchema.parse({
        ...expected,
        diagnostic: { label: "trace" },
        payload: { ...payload, displayHint: "details" },
      });
      expect(parsed).toEqual(expected);
    });

    it.each([
      ["heartbeat", {}],
      ["session_list", { sessions: [] }],
      ["sync_response", { messages: [{ content: "history", providerDetails: { count: 1 } }] }],
    ])("strips descriptions from global %s without changing its payload data", (type, payload) => {
      const expected = makeEnvelope(type, payload);
      expect(
        MessageEnvelopeSchema.parse({
          ...expected,
          diagnostic: { label: "trace" },
          payload: { ...payload, displayHint: "details" },
        }),
      ).toEqual(expected);
    });
  });

  describe("PtyStatePayloadSchema", () => {
    it("validates state working", () => {
      const result = PtyStatePayloadSchema.parse({ state: "working", seq: 1 });
      expect(result.state).toBe("working");
    });

    it("validates state approval_wait with tool", () => {
      const result = PtyStatePayloadSchema.parse({
        state: "approval_wait",
        seq: 3,
        tool: "Bash",
      });
      expect(result.state).toBe("approval_wait");
      expect(result.seq).toBe(3);
      expect(result.tool).toBe("Bash");
    });

    it("validates state turn_complete with title", () => {
      const result = PtyStatePayloadSchema.parse({
        state: "turn_complete",
        seq: 4,
        title: "task done",
      });
      expect(result.state).toBe("turn_complete");
      expect(result.title).toBe("task done");
    });

    it("rejects invalid state value", () => {
      expect(() => PtyStatePayloadSchema.parse({ state: "invalid_state", seq: 1 })).toThrow();
    });

    it("rejects removed mid_pause state", () => {
      expect(() => PtyStatePayloadSchema.parse({ state: "mid_pause", seq: 1 })).toThrow();
    });

    it("requires an event sequence", () => {
      expect(() => PtyStatePayloadSchema.parse({ state: "working" })).toThrow();
    });
  });

  describe("SessionListPayloadSchema mode extension", () => {
    it("accepts session entries with mode field", () => {
      const result = SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "idle",
            mode: "pty",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/project",
            lastActive: 1,
          },
          {
            sessionId: "s2",
            kind: "agent",
            state: "working",
            mode: "json",
            provider: "codex",
            cwd: "/project",
            lastActive: 2,
          },
        ],
      });
      expect(result.sessions[0].mode).toBe("pty");
      expect(result.sessions[1].mode).toBe("json");
      expect(result.sessions[1].provider).toBe("codex");
    });
  });

  describe("invalid messages", () => {
    it("rejects unknown message type", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeEnvelope("unknown_type", { data: 1 })),
      ).toThrow();
    });

    it("rejects mismatched payload for type", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(makeSessionEnvelope("user_input", { wrong: "field" })),
      ).toThrow();
    });

    it("rejects unknown payload fields", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeSessionEnvelope("user_input", {
            text: "hello",
            removedField: "must not be stripped",
          }),
        ),
      ).toThrow();
    });

    it.each(["session_create", "session_switch", "session_terminate"])(
      "rejects removed %s envelope type",
      (type) => {
        expect(() =>
          MessageEnvelopeSchema.parse(
            makeSessionEnvelope(type, {
              sessionId: "test-session",
              cwd: "/project",
            }),
          ),
        ).toThrow();
      },
    );
  });
});
