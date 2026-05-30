import { describe, it, expect } from "vitest";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { IpcMessageSchema } from "#src/ipc/ipc-protocol.js";
import { serializeRawPtyInput } from "#src/serve/pty-input.js";

function parseSerializedIpc(serialized: string) {
  const raw = JSON.parse(serialized.trim());
  return IpcMessageSchema.parse(raw);
}

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
  // 验证核心不变量：parsed data 作为 pty_input 的 data 字段转发，不追加 \r。
  it("preserves raw byte samples without append", () => {
    for (const [label, data] of [
      ["plain text", "abc"],
      ["enter", "\r"],
      ["backspace", "\x7f"],
      ["tab", "\t"],
      ["escape", "\x1b"],
      ["ctrl+c", "\x03"],
      ["arrow up", "\x1b[A"],
      ["arrow down", "\x1b[B"],
      ["arrow right", "\x1b[C"],
      ["arrow left", "\x1b[D"],
      ["paste", "first line\nsecond line"],
      ["ime text", "你好，世界"],
    ]) {
      const raw = { type: "remote_input_raw", sessionId: "s1", data };
      const parsed = RelayControlSchema.safeParse(raw);
      expect(parsed.success, label).toBe(true);

      if (parsed.success && parsed.data.type === "remote_input_raw") {
        const ipc = parseSerializedIpc(
          serializeRawPtyInput(parsed.data.sessionId, parsed.data.data),
        );
        expect(ipc.type, label).toBe("pty_input");
        if (ipc.type === "pty_input") {
          expect(ipc.sessionId, label).toBe("s1");
          expect(ipc.data, label).toBe(data);
        }
      }
    }
  });
});
