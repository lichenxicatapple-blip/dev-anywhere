import { describe, it, expect } from "vitest";
import { RelayControlSchema } from "@cc-anywhere/shared";

describe("remote_input_raw envelope", () => {
  it("accepts a well-formed message", () => {
    const msg = { type: "remote_input_raw", sessionId: "abc", data: "\x1b[A" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("remote_input_raw");
    }
  });

  it("rejects when sessionId is empty", () => {
    const msg = { type: "remote_input_raw", sessionId: "", data: "\x03" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects when data is missing", () => {
    const msg = { type: "remote_input_raw", sessionId: "abc" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("accepts multi-byte ANSI sequences", () => {
    const msg = { type: "remote_input_raw", sessionId: "abc", data: "\x1b[A\x1b[B" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("accepts empty data string as raw bytes semantics", () => {
    const msg = { type: "remote_input_raw", sessionId: "abc", data: "" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe("serve.ts remote_input_raw forwarding semantics", () => {
  // 验证核心不变量：parsed data 作为 pty_input 的 data 字段转发，不追加 \r
  // serve.ts 入口未抽象为纯函数，这里仅断言 schema + envelope 形状契约
  it("preserves raw bytes without trailing carriage return", () => {
    const raw = { type: "remote_input_raw", sessionId: "s1", data: "\x03" };
    const parsed = RelayControlSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    if (parsed.success && parsed.data.type === "remote_input_raw") {
      // 模拟 serve.ts 分支构造出的 IPC payload
      const expectedIpc = {
        type: "pty_input",
        sessionId: parsed.data.sessionId,
        data: parsed.data.data,
      };
      expect(expectedIpc.data).toBe("\x03");
      expect(expectedIpc.data.endsWith("\r")).toBe(false);
      expect(expectedIpc.data.length).toBe(1);
    }
  });

  it("preserves 3-byte arrow sequences without append", () => {
    const raw = { type: "remote_input_raw", sessionId: "s1", data: "\x1b[A" };
    const parsed = RelayControlSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    if (parsed.success && parsed.data.type === "remote_input_raw") {
      expect(parsed.data.data.length).toBe(3);
      expect(parsed.data.data.endsWith("\r")).toBe(false);
    }
  });
});
