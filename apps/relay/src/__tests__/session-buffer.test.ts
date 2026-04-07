import { describe, it, expect, beforeEach } from "vitest";
import { SessionBuffer, type BufferedMessage } from "../session-buffer.js";
import { compressOnSnapshot } from "../buffer-compressor.js";
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

  it("deduplicates by seq on append", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "thinking"));
    // 重发 seq 2 和 3 应被忽略
    buffer.append(makeMsg(2, "assistant_message"));
    buffer.append(makeMsg(3, "thinking"));
    expect(buffer.size()).toBe(3);
    expect(buffer.getAll().map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("allows append after dedup skip", () => {
    buffer.append(makeMsg(1, "user_input"));
    buffer.append(makeMsg(1, "user_input")); // dup, skip
    buffer.append(makeMsg(2, "assistant_message")); // new, accept
    expect(buffer.size()).toBe(2);
    expect(buffer.getAll().map((m) => m.seq)).toEqual([1, 2]);
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

