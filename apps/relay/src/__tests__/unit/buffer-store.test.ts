import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BufferStore } from "#src/buffer-store.js";
import { SessionBuffer, type BufferedMessage } from "#src/session-buffer.js";
import type { MessageType, MessageSource } from "@cc-anywhere/shared";

function makeMsg(seq: number, type: MessageType = "assistant_message", source: MessageSource = "proxy"): BufferedMessage {
  return { raw: JSON.stringify({ seq, type, source }), seq, type, source };
}

describe("BufferStore", () => {
  let dataDir: string;
  let store: BufferStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-buffer-test-"));
    store = new BufferStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("append and load round-trip", () => {
    store.append("s1", makeMsg(1));
    store.append("s1", makeMsg(2));
    const loaded = store.load("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0].seq).toBe(1);
    expect(loaded[1].seq).toBe(2);
  });

  it("load returns empty for unknown session", () => {
    expect(store.load("nonexistent")).toHaveLength(0);
  });

  it("rewrite replaces file content", () => {
    store.append("s1", makeMsg(1));
    store.append("s1", makeMsg(2));
    store.append("s1", makeMsg(3));
    store.rewrite("s1", [makeMsg(3)]);
    const loaded = store.load("s1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].seq).toBe(3);
  });

  it("delete removes session file", () => {
    store.append("s1", makeMsg(1));
    store.delete("s1");
    expect(store.load("s1")).toHaveLength(0);
  });

  it("loadAll returns all sessions", () => {
    store.append("s1", makeMsg(1));
    store.append("s2", makeMsg(10));
    store.append("s2", makeMsg(11));
    const all = store.loadAll();
    expect(all.size).toBe(2);
    expect(all.get("s1")).toHaveLength(1);
    expect(all.get("s2")).toHaveLength(2);
  });
});

describe("SessionBuffer with persistence", () => {
  let dataDir: string;
  let store: BufferStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-buffer-test-"));
    store = new BufferStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("append persists to disk", () => {
    const buffer = new SessionBuffer(store, "s1");
    buffer.append(makeMsg(1));
    buffer.append(makeMsg(2));

    const loaded = store.load("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[1].seq).toBe(2);
  });

  it("replaceMessages rewrites on disk", () => {
    const buffer = new SessionBuffer(store, "s1");
    buffer.append(makeMsg(1));
    buffer.append(makeMsg(2));
    buffer.append(makeMsg(3));

    buffer.replaceMessages([makeMsg(3)]);

    const loaded = store.load("s1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].seq).toBe(3);
  });

  it("clear deletes from disk", () => {
    const buffer = new SessionBuffer(store, "s1");
    buffer.append(makeMsg(1));
    buffer.clear();
    expect(store.load("s1")).toHaveLength(0);
  });

  it("buffer without store does not write to disk", () => {
    const buffer = new SessionBuffer();
    buffer.append(makeMsg(1));
    expect(store.loadAll().size).toBe(0);
  });

  it("survives simulated relay restart", () => {
    const buffer = new SessionBuffer(store, "s1");
    buffer.append(makeMsg(1));
    buffer.append(makeMsg(2));
    buffer.append(makeMsg(3));

    // 模拟 relay 重启：创建新 store 实例从同一目录加载
    const store2 = new BufferStore(dataDir);
    const loaded = store2.loadAll();
    expect(loaded.size).toBe(1);

    const restoredBuffer = new SessionBuffer(store2, "s1");
    restoredBuffer.loadMessages(loaded.get("s1")!);
    expect(restoredBuffer.size()).toBe(3);
    expect(restoredBuffer.getAfterSeq(1)).toHaveLength(2);
  });
});
