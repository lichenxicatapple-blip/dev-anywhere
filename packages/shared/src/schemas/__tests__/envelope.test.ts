import { describe, it, expect } from "vitest";
import { MessageEnvelopeSchema } from "../envelope.js";
import {
  TerminalFramePayloadSchema,
  PtyStatePayloadSchema,
  SessionCreatePayloadSchema,
  SessionListPayloadSchema,
} from "../session.js";

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

  describe("TerminalFramePayloadSchema", () => {
    it("validates lines with full span attributes", () => {
      const result = TerminalFramePayloadSchema.parse({
        mode: "full",
        lines: [[{ text: "hello", fg: "#00FF00", bold: true }]],
      });
      const lines = result.lines as Array<Array<{ text: string; fg?: string; bold?: boolean }>>;
      expect(lines[0][0].text).toBe("hello");
      expect(lines[0][0].fg).toBe("#00FF00");
      expect(lines[0][0].bold).toBe(true);
    });

    it("validates minimal span without optional fields", () => {
      const result = TerminalFramePayloadSchema.parse({
        mode: "full",
        lines: [[{ text: " " }]],
      });
      const lines = result.lines as Array<Array<{ text: string; fg?: string }>>;
      expect(lines[0][0].text).toBe(" ");
      expect(lines[0][0].fg).toBeUndefined();
    });

    it("rejects lines that is not an array", () => {
      expect(() =>
        TerminalFramePayloadSchema.parse({ lines: "not an array" }),
      ).toThrow();
    });
  });

  describe("PtyStatePayloadSchema", () => {
    it("validates state working", () => {
      const result = PtyStatePayloadSchema.parse({ state: "working" });
      expect(result.state).toBe("working");
    });

    it("validates state approval_wait with tool", () => {
      const result = PtyStatePayloadSchema.parse({
        state: "approval_wait",
        tool: "Bash",
      });
      expect(result.state).toBe("approval_wait");
      expect(result.tool).toBe("Bash");
    });

    it("validates state turn_complete with title", () => {
      const result = PtyStatePayloadSchema.parse({
        state: "turn_complete",
        title: "task done",
      });
      expect(result.state).toBe("turn_complete");
      expect(result.title).toBe("task done");
    });

    it("rejects invalid state value", () => {
      expect(() =>
        PtyStatePayloadSchema.parse({ state: "invalid_state" }),
      ).toThrow();
    });
  });

  describe("SessionCreatePayloadSchema cwd extension", () => {
    it("accepts name and cwd", () => {
      const result = SessionCreatePayloadSchema.parse({
        name: "test",
        cwd: "/home/user/project",
      });
      expect(result.cwd).toBe("/home/user/project");
    });

    it("accepts name without cwd (optional)", () => {
      const result = SessionCreatePayloadSchema.parse({ name: "test" });
      expect(result.cwd).toBeUndefined();
    });
  });

  describe("SessionListPayloadSchema mode extension", () => {
    it("accepts session entries with mode field", () => {
      const result = SessionListPayloadSchema.parse({
        sessions: [
          { sessionId: "s1", state: "idle", mode: "pty" },
          { sessionId: "s2", state: "working", mode: "json" },
        ],
      });
      expect(result.sessions[0].mode).toBe("pty");
      expect(result.sessions[1].mode).toBe("json");
    });
  });

  describe("removed envelope types", () => {
    it("rejects pty_snapshot (removed from envelope)", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("pty_snapshot", { data: "base64data" }),
        ),
      ).toThrow();
    });

    it("rejects terminal_frame (moved to Control)", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("terminal_frame", { lines: [[{ text: "x" }]] }),
        ),
      ).toThrow();
    });

    it("rejects pty_state (moved to Control)", () => {
      expect(() =>
        MessageEnvelopeSchema.parse(
          makeEnvelope("pty_state", { state: "working" }),
        ),
      ).toThrow();
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
