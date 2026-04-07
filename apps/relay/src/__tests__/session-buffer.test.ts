import { describe, it, expect, beforeEach } from "vitest";
import { SessionBuffer, type BufferedMessage } from "../session-buffer.js";
import { compressOnSnapshot, compressOnResult } from "../buffer-compressor.js";
import type { MessageType, MessageSource } from "@cc-anywhere/shared";

// 构造测试用 BufferedMessage
function makeMsg(
  seq: number,
  type: MessageType,
  source: MessageSource = "proxy",
): BufferedMessage {
  return {
    raw: JSON.stringify({ seq, type, source }),
    seq,
    type,
    source,
  };
}

describe("SessionBuffer", () => {
  let buffer: SessionBuffer;

  beforeEach(() => {
    buffer = new SessionBuffer();
  });

  it("append adds message and size returns count", () => {
    buffer.append(makeMsg(1, "assistant_message"));
    buffer.append(makeMsg(2, "assistant_message"));
    expect(buffer.size()).toBe(2);
  });

  it("getAll returns all buffered messages as a copy", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    const all = buffer.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(1);
    expect(all[1].seq).toBe(2);
    // 是副本而非原始引用
    all.push(makeMsg(99, "error"));
    expect(buffer.size()).toBe(2);
  });

  it("getAfterSeq returns messages with seq > lastSeq", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "tool_use_request"));
    buffer.append(makeMsg(4, "tool_result"));

    const after2 = buffer.getAfterSeq(2);
    expect(after2).toHaveLength(2);
    expect(after2[0].seq).toBe(3);
    expect(after2[1].seq).toBe(4);
  });

  it("getAfterSeq with 0 returns all messages", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    expect(buffer.getAfterSeq(0)).toHaveLength(2);
  });

  it("getRange returns messages within inclusive range", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "thinking"));
    buffer.append(makeMsg(4, "tool_result"));

    const range = buffer.getRange(2, 3);
    expect(range).toHaveLength(2);
    expect(range[0].seq).toBe(2);
    expect(range[1].seq).toBe(3);
  });

  it("clear empties the buffer", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.clear();
    expect(buffer.size()).toBe(0);
    expect(buffer.getAll()).toHaveLength(0);
  });

  it("FIFO eviction at maxSize cap", () => {
    const smallBuffer = new SessionBuffer(5);
    for (let i = 1; i <= 7; i++) {
      smallBuffer.append(makeMsg(i, "assistant_message"));
    }
    // 7 appended, cap is 5, oldest 2 should be evicted
    expect(smallBuffer.size()).toBe(5);
    const all = smallBuffer.getAll();
    expect(all[0].seq).toBe(3);
    expect(all[4].seq).toBe(7);
  });

  it("FIFO eviction at default 1000 cap", () => {
    for (let i = 1; i <= 1002; i++) {
      buffer.append(makeMsg(i, "assistant_message"));
    }
    expect(buffer.size()).toBe(1000);
    const all = buffer.getAll();
    expect(all[0].seq).toBe(3);
    expect(all[999].seq).toBe(1002);
  });

  it("replaceMessages overwrites internal buffer", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "thinking"));

    buffer.replaceMessages([makeMsg(2, "assistant_message")]);
    expect(buffer.size()).toBe(1);
    expect(buffer.getAll()[0].seq).toBe(2);
  });
});

describe("compressOnSnapshot", () => {
  it("removes all messages before snapshot message", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "session_status")); // snapshot
    buffer.append(makeMsg(4, "user_input"));
    buffer.append(makeMsg(5, "assistant_message"));

    compressOnSnapshot(buffer, 3);

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].seq).toBe(3);
    expect(all[1].seq).toBe(4);
    expect(all[2].seq).toBe(5);
  });

  it("does nothing if snapshot seq not found", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));

    compressOnSnapshot(buffer, 99);
    expect(buffer.size()).toBe(2);
  });

  it("does nothing if snapshot is already first message", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "session_status")); // snapshot at index 0
    buffer.append(makeMsg(2, "user_input"));

    compressOnSnapshot(buffer, 1);
    expect(buffer.size()).toBe(2);
  });
});

describe("compressOnResult", () => {
  it("removes streaming deltas between user_input and result", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "thinking"));
    buffer.append(makeMsg(3, "assistant_message"));
    buffer.append(makeMsg(4, "thinking"));
    buffer.append(makeMsg(5, "assistant_message"));
    buffer.append(makeMsg(6, "tool_use_request"));
    buffer.append(makeMsg(7, "tool_approve"));
    buffer.append(makeMsg(8, "tool_result"));

    compressOnResult(buffer, 8);

    const all = buffer.getAll();
    // user_input(1), tool_use_request(6), tool_approve(7), tool_result(8) should remain
    // thinking(2,4) and assistant_message(3,5) should be removed
    expect(all.map((m) => m.seq)).toEqual([1, 6, 7, 8]);
  });

  it("preserves messages before the turn and after result", () => {
    const buffer = new SessionBuffer();
    // 上一个 turn 的消息
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "tool_result"));
    // 当前 turn
    buffer.append(makeMsg(4, "user_input"));
    buffer.append(makeMsg(5, "thinking"));
    buffer.append(makeMsg(6, "assistant_message"));
    buffer.append(makeMsg(7, "tool_result"));
    // 后续消息
    buffer.append(makeMsg(8, "user_input"));

    compressOnResult(buffer, 7);

    const all = buffer.getAll();
    // 1,2,3 不在 turn 范围内保留，4 保留（user_input），5,6 被删除，7 保留（result），8 保留
    expect(all.map((m) => m.seq)).toEqual([1, 2, 3, 4, 7, 8]);
  });

  it("does nothing if result seq not found", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "thinking"));

    compressOnResult(buffer, 99);
    expect(buffer.size()).toBe(2);
  });

  it("preserves session control messages within turn", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "thinking"));
    buffer.append(makeMsg(3, "session_status"));
    buffer.append(makeMsg(4, "assistant_message"));
    buffer.append(makeMsg(5, "tool_result"));

    compressOnResult(buffer, 5);

    const all = buffer.getAll();
    // user_input(1), session_status(3), tool_result(5) remain
    // thinking(2), assistant_message(4) removed
    expect(all.map((m) => m.seq)).toEqual([1, 3, 5]);
  });
});
