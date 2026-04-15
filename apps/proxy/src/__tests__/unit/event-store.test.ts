import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { EventStore, EventType, encodeEvent, decodeEvent, writeFileHeader, HEADER_SIZE, EVENT_OVERHEAD } from "#src/event-store.js";

describe("CCAE binary format: file header", () => {
  it("writeFileHeader produces 6 bytes: 4B 'CCAE' + 2B version 0x0001 LE", () => {
    const header = writeFileHeader();
    expect(header.length).toBe(6);
    expect(header.subarray(0, 4).toString("ascii")).toBe("CCAE");
    expect(header.readUInt16LE(4)).toBe(1);
  });
});

describe("CCAE binary format: encodeEvent / decodeEvent", () => {
  it("encodeEvent(PTY_DATA, payload) uses type=0x01 with correct structure", () => {
    const payload = Buffer.from("hello world");
    const buf = encodeEvent(EventType.PTY_DATA, payload);

    expect(buf.readUInt8(0)).toBe(0x01);
    // timestamp is 8B float64LE at offset 1
    const ts = buf.readDoubleLE(1);
    expect(ts).toBeGreaterThan(0);
    // payload_len at offset 9
    expect(buf.readUInt32LE(9)).toBe(payload.length);
    // payload at offset 13
    expect(buf.subarray(13, 13 + payload.length).toString()).toBe("hello world");
    // total_len trailer at end
    const totalLen = buf.readUInt32LE(buf.length - 4);
    expect(totalLen).toBe(EVENT_OVERHEAD + payload.length);
    expect(totalLen).toBe(buf.length);
  });

  it("encodeEvent(SNAPSHOT, payload) uses type=0x02", () => {
    const payload = Buffer.from("serialized terminal state");
    const buf = encodeEvent(EventType.SNAPSHOT, payload);
    expect(buf.readUInt8(0)).toBe(0x02);
  });

  it("encodeEvent(RESIZE, 4B payload) uses type=0x03", () => {
    const resizePayload = Buffer.alloc(4);
    resizePayload.writeUInt16LE(120, 0);
    resizePayload.writeUInt16LE(40, 2);
    const buf = encodeEvent(EventType.RESIZE, resizePayload);
    expect(buf.readUInt8(0)).toBe(0x03);
    // payload should contain cols=120, rows=40
    const pStart = 13;
    expect(buf.readUInt16LE(pStart)).toBe(120);
    expect(buf.readUInt16LE(pStart + 2)).toBe(40);
  });

  it("encodeEvent(METADATA, JSON payload) uses type=0x04", () => {
    const meta = { cols: 80, rows: 24, sessionId: "abc123" };
    const payload = Buffer.from(JSON.stringify(meta), "utf-8");
    const buf = encodeEvent(EventType.METADATA, payload);
    expect(buf.readUInt8(0)).toBe(0x04);
  });

  it("total_len trailer = 17 + N (EVENT_OVERHEAD + payload.length)", () => {
    const payload = Buffer.alloc(50);
    const buf = encodeEvent(EventType.PTY_DATA, payload);
    const totalLen = buf.readUInt32LE(buf.length - 4);
    expect(totalLen).toBe(17 + 50);
    expect(totalLen).toBe(buf.length);
  });

  it("decodeEvent reads an encoded event and returns {type, timestamp, payload}", () => {
    const payload = Buffer.from("test data");
    const encoded = encodeEvent(EventType.PTY_DATA, payload);
    const decoded = decodeEvent(encoded, 0);

    expect(decoded.type).toBe(EventType.PTY_DATA);
    expect(decoded.timestamp).toBeGreaterThan(0);
    expect(decoded.payload.toString()).toBe("test data");
    expect(decoded.totalLen).toBe(encoded.length);
  });
});

describe("EventStore: file operations", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-test-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  afterEach(() => {
    // 测试清理由系统临时目录自动处理
  });

  it("constructor opens fd with write access", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    // 文件应被创建
    expect(existsSync(eventsPath)).toBe(true);
    // 文件头 + METADATA 事件
    const size = statSync(eventsPath).size;
    expect(size).toBeGreaterThan(HEADER_SIZE);
    store.closeSync();
  });

  it("appendPtyData writes event immediately (file size grows after each call)", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    const sizeBefore = statSync(eventsPath).size;
    store.appendPtyData(Buffer.from("data chunk 1"));
    const sizeAfter1 = statSync(eventsPath).size;
    expect(sizeAfter1).toBeGreaterThan(sizeBefore);

    store.appendPtyData(Buffer.from("data chunk 2"));
    const sizeAfter2 = statSync(eventsPath).size;
    expect(sizeAfter2).toBeGreaterThan(sizeAfter1);

    store.closeSync();
  });

  it("appendSnapshot writes SNAPSHOT event with serialized output", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    store.appendSnapshot("terminal state snapshot data");
    const data = readFileSync(eventsPath);

    // 查找 SNAPSHOT 事件
    let offset = HEADER_SIZE;
    let foundSnapshot = false;
    while (offset < data.length) {
      const type = data.readUInt8(offset);
      const payloadLen = data.readUInt32LE(offset + 9);
      const totalLen = data.readUInt32LE(offset + 13 + payloadLen);
      if (type === EventType.SNAPSHOT) {
        const payload = data.subarray(offset + 13, offset + 13 + payloadLen);
        expect(payload.toString("utf-8")).toBe("terminal state snapshot data");
        foundSnapshot = true;
      }
      offset += totalLen;
    }
    expect(foundSnapshot).toBe(true);

    store.closeSync();
  });

  it("appendMetadata writes METADATA event as first event after header", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    const data = readFileSync(eventsPath);
    // 第一个事件应该是 METADATA
    const type = data.readUInt8(HEADER_SIZE);
    expect(type).toBe(EventType.METADATA);

    const payloadLen = data.readUInt32LE(HEADER_SIZE + 9);
    const payload = data.subarray(HEADER_SIZE + 13, HEADER_SIZE + 13 + payloadLen);
    const meta = JSON.parse(payload.toString("utf-8"));
    expect(meta.cols).toBe(80);
    expect(meta.rows).toBe(24);
    expect(meta.sessionId).toBe("test-1");

    store.closeSync();
  });

  it("appendResize writes RESIZE event with cols/rows", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    store.appendResize(120, 40);
    const data = readFileSync(eventsPath);

    // 找到 RESIZE 事件
    let offset = HEADER_SIZE;
    let foundResize = false;
    while (offset < data.length) {
      const type = data.readUInt8(offset);
      const payloadLen = data.readUInt32LE(offset + 9);
      const totalLen = data.readUInt32LE(offset + 13 + payloadLen);
      if (type === EventType.RESIZE) {
        expect(payloadLen).toBe(4);
        const cols = data.readUInt16LE(offset + 13);
        const rows = data.readUInt16LE(offset + 15);
        expect(cols).toBe(120);
        expect(rows).toBe(40);
        foundResize = true;
      }
      offset += totalLen;
    }
    expect(foundResize).toBe(true);

    store.closeSync();
  });

  it("shouldSnapshot returns true every SNAPSHOT_INTERVAL events", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    // METADATA 事件是 event #1，写入 99 个 PTY_DATA 到 event #100
    let snapshotTriggered = false;
    for (let i = 0; i < 99; i++) {
      store.appendPtyData(Buffer.from(`data ${i}`));
      if (store.shouldSnapshot()) {
        snapshotTriggered = true;
        break;
      }
    }
    expect(snapshotTriggered).toBe(true);

    store.closeSync();
  });
});

describe("EventStore: readEventsFromFile", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-read-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("readEventsFromFile reads file header + all events sequentially", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("chunk 1"));
    store.appendPtyData(Buffer.from("chunk 2"));
    store.appendPtyData(Buffer.from("chunk 3"));
    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    // METADATA + 3 PTY_DATA = 4 events
    expect(events.length).toBe(4);
    expect(events[0].type).toBe(EventType.METADATA);
    expect(events[1].type).toBe(EventType.PTY_DATA);
    expect(events[1].payload.toString()).toBe("chunk 1");
    expect(events[2].payload.toString()).toBe("chunk 2");
    expect(events[3].payload.toString()).toBe("chunk 3");
  });
});

describe("EventStore: findLatestSnapshot (reverse scan)", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-scan-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("findLatestSnapshot reverse-scans from file end, returns SNAPSHOT payload", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    store.appendPtyData(Buffer.from("data 1"));
    store.appendSnapshot("snapshot-A");
    store.appendPtyData(Buffer.from("data 2"));
    store.appendSnapshot("snapshot-B");
    store.appendPtyData(Buffer.from("data 3"));
    store.closeSync();

    const result = EventStore.findLatestSnapshot(eventsPath);
    expect(result).not.toBeNull();
    expect(result!.toString("utf-8")).toBe("snapshot-B");
  });

  it("findLatestSnapshot returns null when no SNAPSHOT exists", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("data only"));
    store.closeSync();

    const result = EventStore.findLatestSnapshot(eventsPath);
    expect(result).toBeNull();
  });
});

describe("EventStore: rotation", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-rotate-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("rotate moves events.bin to events.001.bin.gz, creates new events.bin with header + SNAPSHOT", async () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("original data"));
    store.appendSnapshot("snapshot for rotation");
    await store.rotate("current snapshot after rotation");

    // 归档文件应存在
    const archivePath = join(tmpDir, "events.001.bin.gz");
    expect(existsSync(archivePath)).toBe(true);

    // 归档应该是 gzip 数据，解压后包含 CCAE header
    const compressed = readFileSync(archivePath);
    const decompressed = gunzipSync(compressed);
    expect(decompressed.subarray(0, 4).toString("ascii")).toBe("CCAE");

    // 新的 events.bin 应该存在，包含 header + METADATA + SNAPSHOT
    expect(existsSync(eventsPath)).toBe(true);
    const newData = readFileSync(eventsPath);
    expect(newData.subarray(0, 4).toString("ascii")).toBe("CCAE");

    // 新文件第一个事件应该是 METADATA
    expect(newData.readUInt8(HEADER_SIZE)).toBe(EventType.METADATA);

    // 找 SNAPSHOT 事件
    let offset = HEADER_SIZE;
    let foundSnapshot = false;
    while (offset < newData.length) {
      const type = newData.readUInt8(offset);
      const payloadLen = newData.readUInt32LE(offset + 9);
      const totalLen = newData.readUInt32LE(offset + 13 + payloadLen);
      if (type === EventType.SNAPSHOT) {
        const payload = newData.subarray(offset + 13, offset + 13 + payloadLen);
        expect(payload.toString("utf-8")).toBe("current snapshot after rotation");
        foundSnapshot = true;
      }
      offset += totalLen;
    }
    expect(foundSnapshot).toBe(true);

    store.closeSync();
  });

  it("rotate increments sequence number: .001, .002, .003", async () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("data 1"));

    await store.rotate("snap1");
    expect(existsSync(join(tmpDir, "events.001.bin.gz"))).toBe(true);

    store.appendPtyData(Buffer.from("data 2"));
    await store.rotate("snap2");
    expect(existsSync(join(tmpDir, "events.002.bin.gz"))).toBe(true);

    store.appendPtyData(Buffer.from("data 3"));
    await store.rotate("snap3");
    expect(existsSync(join(tmpDir, "events.003.bin.gz"))).toBe(true);

    store.closeSync();
  });

  it("rotate triggers when file size exceeds threshold", () => {
    const store = new EventStore(eventsPath, 100); // 100 bytes threshold for testing
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    // 写入足够多数据超过 threshold
    store.appendPtyData(Buffer.alloc(200, 0x41));
    expect(store.shouldRotate()).toBe(true);

    store.closeSync();
  });
});

describe("EventStore: close", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-close-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("close gzips remaining active file at session end", async () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("session data"));
    await store.close();

    // events.bin 应被归档为 events.bin.gz
    expect(existsSync(join(tmpDir, "events.bin.gz"))).toBe(true);
    // 原始文件不再存在
    expect(existsSync(eventsPath)).toBe(false);

    // 验证归档内容
    const compressed = readFileSync(join(tmpDir, "events.bin.gz"));
    const decompressed = gunzipSync(compressed);
    expect(decompressed.subarray(0, 4).toString("ascii")).toBe("CCAE");
  });
});

describe("EventStore: readEventsAfterSnapshot", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-after-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("returns events after the given snapshot offset", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("before snapshot"));
    store.appendSnapshot("the snapshot");
    store.appendPtyData(Buffer.from("after 1"));
    store.appendPtyData(Buffer.from("after 2"));
    store.closeSync();

    // 找 snapshot offset
    const allEvents = EventStore.readEventsFromFile(eventsPath);
    let snapshotOffset = HEADER_SIZE;
    for (const ev of allEvents) {
      if (ev.type === EventType.SNAPSHOT) break;
      snapshotOffset += ev.totalLen;
    }

    const afterEvents = EventStore.readEventsAfterSnapshot(eventsPath, snapshotOffset);
    // 包含 SNAPSHOT 本身 + 2 个 PTY_DATA
    expect(afterEvents.length).toBe(3);
    expect(afterEvents[0].type).toBe(EventType.SNAPSHOT);
    expect(afterEvents[1].payload.toString()).toBe("after 1");
    expect(afterEvents[2].payload.toString()).toBe("after 2");
  });
});
