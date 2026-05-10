import { describe, it, expect } from "vitest";
import { encodeBinaryFrame, decodeBinaryFrame, binaryFrameHeaderLength } from "../binary-frame.js";

describe("binary-frame", () => {
  it("encode → decode round-trips simple ASCII payload", () => {
    const data = new TextEncoder().encode("hello world");
    const frame = encodeBinaryFrame("sess-1", 42, data);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.sessionId).toBe("sess-1");
    expect(decoded?.outputSeq).toBe(42);
    expect(new TextDecoder().decode(decoded!.data)).toBe("hello world");
  });

  it("encode → decode preserves binary bytes including 0x00", () => {
    const data = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80]);
    const frame = encodeBinaryFrame("s", 1, data);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded?.data).toEqual(data);
  });

  it("encodes outputSeq as little-endian uint32", () => {
    const data = new Uint8Array(0);
    const frame = encodeBinaryFrame("s", 0x01020304, data);
    // 帧布局：[1B sid_len=1]['s'.charCodeAt][4B seq LE]
    // little-endian 0x01020304 → 04 03 02 01
    expect(frame[2]).toBe(0x04);
    expect(frame[3]).toBe(0x03);
    expect(frame[4]).toBe(0x02);
    expect(frame[5]).toBe(0x01);
  });

  it("supports multi-byte UTF-8 sessionId", () => {
    const sessionId = "会-话-1"; // mix of CJK + ASCII
    const data = new TextEncoder().encode("payload");
    const frame = encodeBinaryFrame(sessionId, 7, data);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded?.sessionId).toBe(sessionId);
    expect(decoded?.outputSeq).toBe(7);
    expect(new TextDecoder().decode(decoded!.data)).toBe("payload");
  });

  it("rejects empty sessionId", () => {
    expect(() => encodeBinaryFrame("", 0, new Uint8Array())).toThrow(/byte length must be 1-255/);
  });

  it("rejects sessionId longer than 255 bytes", () => {
    const longId = "x".repeat(256);
    expect(() => encodeBinaryFrame(longId, 0, new Uint8Array())).toThrow(
      /byte length must be 1-255/,
    );
  });

  it("rejects negative or non-integer outputSeq", () => {
    expect(() => encodeBinaryFrame("s", -1, new Uint8Array())).toThrow(/uint32/);
    expect(() => encodeBinaryFrame("s", 1.5, new Uint8Array())).toThrow(/uint32/);
    expect(() => encodeBinaryFrame("s", 0x100000000, new Uint8Array())).toThrow(/uint32/);
  });

  it("decode returns null for under-length frame (no header)", () => {
    expect(decodeBinaryFrame(new Uint8Array(0))).toBeNull();
    expect(decodeBinaryFrame(new Uint8Array([5]))).toBeNull(); // sid_len present but no seq
  });

  it("decode returns null when sid_len = 0", () => {
    expect(decodeBinaryFrame(new Uint8Array([0, 0, 0, 0, 0]))).toBeNull();
  });

  it("decode returns null when sessionId bytes are truncated", () => {
    // sid_len = 5 but only 3 bytes follow + missing seq
    expect(decodeBinaryFrame(new Uint8Array([5, 0x61, 0x62, 0x63]))).toBeNull();
  });

  it("decode returns empty data when frame ends right after seq", () => {
    const frame = encodeBinaryFrame("s", 1, new Uint8Array(0));
    const decoded = decodeBinaryFrame(frame);
    expect(decoded?.data.length).toBe(0);
  });

  it("binaryFrameHeaderLength matches the actual encoded header bytes", () => {
    const sessionId = "测试";
    const sidByteLen = new TextEncoder().encode(sessionId).length;
    const headerLen = binaryFrameHeaderLength(sessionId);
    expect(headerLen).toBe(1 + sidByteLen + 4);

    const frame = encodeBinaryFrame(sessionId, 0, new Uint8Array(10));
    expect(frame.length).toBe(headerLen + 10);
  });

  it("decode handles a Uint8Array view into a larger buffer (subarray)", () => {
    const inner = encodeBinaryFrame("sess-1", 99, new TextEncoder().encode("xyz"));
    // 模拟 IPC 层的 outer wrapper：在 inner 帧前后塞 padding，然后用 subarray 切出 inner
    const wrapper = new Uint8Array(10 + inner.length + 5);
    wrapper.set(inner, 10);
    const view = wrapper.subarray(10, 10 + inner.length);
    const decoded = decodeBinaryFrame(view);
    expect(decoded?.sessionId).toBe("sess-1");
    expect(decoded?.outputSeq).toBe(99);
    expect(new TextDecoder().decode(decoded!.data)).toBe("xyz");
  });
});
