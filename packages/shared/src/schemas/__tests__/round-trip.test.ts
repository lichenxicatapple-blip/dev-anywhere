import { describe, it, expect } from "vitest";
import { MessageEnvelopeSchema } from "../envelope.js";
import { RelayControlSchema } from "../relay-control.js";

// 协议往返不变性：parse → JSON.stringify → parse 必须等幂。
// 任何 transform / strip / coerce 在 round-trip 期间静默改写字段，
// 都会让 proxy 发出的消息与 client 解析后的消息不一致，造成难定位的协议 drift。
function roundTrip<T>(schema: { parse: (v: unknown) => T }, raw: unknown): T {
  const parsed = schema.parse(raw);
  const serialized = JSON.stringify(parsed);
  return schema.parse(JSON.parse(serialized));
}

describe("MessageEnvelopeSchema round-trip stability", () => {
  const baseEnv = (type: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
    seq: 1,
    sessionId: "sess-rt",
    timestamp: 1700000000000,
    source: "proxy",
    version: "1.0",
    type,
    payload,
    ...overrides,
  });

  it("user_input with optional messageId survives a round-trip", () => {
    const original = baseEnv("user_input", { text: "hello", messageId: "msg-1" });
    const a = MessageEnvelopeSchema.parse(original);
    const b = roundTrip(MessageEnvelopeSchema, original);
    expect(b).toEqual(a);
  });

  it("assistant_message round-trip preserves isPartial=true", () => {
    const original = baseEnv("assistant_message", { text: "delta", isPartial: true });
    const a = MessageEnvelopeSchema.parse(original);
    const b = roundTrip(MessageEnvelopeSchema, original);
    expect(b).toEqual(a);
    if (b.type === "assistant_message") expect(b.payload.isPartial).toBe(true);
  });

  it("tool_use_request with nested object parameters preserves structure", () => {
    const original = baseEnv("tool_use_request", {
      toolName: "Edit",
      toolId: "toolu_01",
      parameters: {
        file_path: "/tmp/x",
        old_string: "a\nb",
        new_string: "c\nd",
        nested: { ok: true, list: [1, "two", { three: 3 }] },
      },
    });
    const a = MessageEnvelopeSchema.parse(original);
    const b = roundTrip(MessageEnvelopeSchema, original);
    expect(b).toEqual(a);
  });

  it("tool_result with isError=true preserves the boolean", () => {
    const original = baseEnv("tool_result", {
      toolId: "toolu_01",
      result: "permission denied",
      isError: true,
    });
    const a = MessageEnvelopeSchema.parse(original);
    const b = roundTrip(MessageEnvelopeSchema, original);
    expect(b).toEqual(a);
    if (b.type === "tool_result") expect(b.payload.isError).toBe(true);
  });

  it("thinking payload preserves long text content", () => {
    const original = baseEnv("thinking", { text: "L".repeat(2048) });
    const a = MessageEnvelopeSchema.parse(original);
    const b = roundTrip(MessageEnvelopeSchema, original);
    expect(b).toEqual(a);
  });
});

describe("RelayControlSchema round-trip stability", () => {
  it("session_create with all optional fields preserved", () => {
    const original = {
      type: "session_create",
      requestId: "req-1",
      cwd: "/home/u/proj",
      name: "Release checklist",
      provider: "claude",
      mode: "pty",
      resumeSessionId: "sess-prev",
      terminalTheme: "light",
      permissionMode: "default",
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
    expect(b).toMatchObject({ name: "Release checklist" });
  });

  it("session_create_response minimum success shape", () => {
    const original = {
      type: "session_create_response",
      requestId: "req-1",
      success: true,
      sessionId: "sess-new",
      name: "Release checklist",
      nameLocked: true,
      mode: "json",
      provider: "claude",
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
    expect(b).toMatchObject({ name: "Release checklist", nameLocked: true });
  });

  it("proxy_list_response with mixed online states preserved", () => {
    const original = {
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", name: "DEV Mac", online: true },
        { proxyId: "p2", online: false },
      ],
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
  });

  it("clipboard_image_upload binary-ish base64 payload preserved", () => {
    const original = {
      type: "clipboard_image_upload",
      requestId: "clip-1",
      sessionId: "sess-rt",
      mimeType: "image/png",
      dataBase64: "AQID/+8=",
      fileName: "shot.png",
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
  });

  it("agent_status with provider + phase + tool context preserved", () => {
    const original = {
      type: "agent_status",
      sessionId: "sess-rt",
      payload: {
        provider: "codex",
        phase: "tool_use",
        seq: 7,
        updatedAt: 1700000000000,
        toolName: "Bash",
        toolInput: { command: "ls -la" },
        permissionResolution: { requestId: "req-1", outcome: "allow" },
      },
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
  });

  it("session_history_messages preserves nextBefore optional cursor only when present", () => {
    const withCursor = {
      type: "session_history_messages",
      sessionId: "sess-rt",
      messages: [],
      hasMore: true,
      nextBefore: "b:1024",
    };
    const a = RelayControlSchema.parse(withCursor);
    const b = roundTrip(RelayControlSchema, withCursor);
    expect(b).toEqual(a);
    if (b.type === "session_history_messages") expect(b.nextBefore).toBe("b:1024");

    // 缺省 nextBefore 时 round-trip 后仍为 undefined（不能被 zod 默认化或残留为 null）
    const withoutCursor = {
      type: "session_history_messages",
      sessionId: "sess-rt",
      messages: [],
      hasMore: false,
    };
    const c = RelayControlSchema.parse(withoutCursor);
    const d = roundTrip(RelayControlSchema, withoutCursor);
    expect(d).toEqual(c);
    if (d.type === "session_history_messages") expect(d.nextBefore).toBeUndefined();
  });

  it("agent_status with optional fields absent stays undefined after round-trip", () => {
    const original = {
      type: "agent_status",
      sessionId: "sess-rt",
      payload: {
        provider: "claude",
        phase: "idle",
        seq: 0,
        updatedAt: 1700000000000,
      },
    };
    const a = RelayControlSchema.parse(original);
    const b = roundTrip(RelayControlSchema, original);
    expect(b).toEqual(a);
    if (b.type === "agent_status") {
      expect(b.payload.toolName).toBeUndefined();
      expect(b.payload.toolInput).toBeUndefined();
      expect(b.payload.permissionResolution).toBeUndefined();
    }
  });
});
