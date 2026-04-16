import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

    store.appendSnapshot("terminal state snapshot data", 80, 24);
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
        // payload 格式: [2B cols][2B rows][text]
        expect(payload.readUInt16LE(0)).toBe(80);
        expect(payload.readUInt16LE(2)).toBe(24);
        expect(payload.subarray(4).toString("utf-8")).toBe("terminal state snapshot data");
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
    store.appendSnapshot("snapshot-A", 80, 24);
    store.appendPtyData(Buffer.from("data 2"));
    store.appendSnapshot("snapshot-B", 120, 40);
    store.appendPtyData(Buffer.from("data 3"));
    store.closeSync();

    const result = EventStore.findLatestSnapshot(eventsPath);
    expect(result).not.toBeNull();
    expect(result!.cols).toBe(120);
    expect(result!.rows).toBe(40);
    expect(result!.data.toString("utf-8")).toBe("snapshot-B");
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

  it("rotate replaces events.bin with new file containing METADATA + SNAPSHOT", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("original data"));
    store.appendSnapshot("old snapshot", 80, 24);

    const sizeBefore = statSync(eventsPath).size;
    store.rotate("fresh snapshot after rotation", 80, 24);

    // 旧数据被截断，新文件应该比轮转前小很多
    const sizeAfter = statSync(eventsPath).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);

    // 新文件是合法 CCAE 格式
    const newData = readFileSync(eventsPath);
    expect(newData.subarray(0, 4).toString("ascii")).toBe("CCAE");

    // 第一个事件是 METADATA
    expect(newData.readUInt8(HEADER_SIZE)).toBe(EventType.METADATA);

    // 包含传入的最新 SNAPSHOT
    let offset = HEADER_SIZE;
    let foundSnapshot = false;
    while (offset < newData.length) {
      const type = newData.readUInt8(offset);
      const payloadLen = newData.readUInt32LE(offset + 9);
      const totalLen = newData.readUInt32LE(offset + 13 + payloadLen);
      if (type === EventType.SNAPSHOT) {
        const payload = newData.subarray(offset + 13, offset + 13 + payloadLen);
        expect(payload.readUInt16LE(0)).toBe(80);
        expect(payload.readUInt16LE(2)).toBe(24);
        expect(payload.subarray(4).toString("utf-8")).toBe("fresh snapshot after rotation");
        foundSnapshot = true;
      }
      offset += totalLen;
    }
    expect(foundSnapshot).toBe(true);

    // 不产生 .gz 归档文件
    const gzFiles = readdirSync(tmpDir).filter(f => f.endsWith(".gz"));
    expect(gzFiles).toHaveLength(0);

    store.closeSync();
  });

  it("rotate preserves write capability, new events append correctly", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("before rotation"));
    store.rotate("snap", 80, 24);

    // 轮转后继续写入
    store.appendPtyData(Buffer.from("after rotation"));
    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    const ptyEvents = events.filter(e => e.type === EventType.PTY_DATA);
    expect(ptyEvents).toHaveLength(1);
    expect(ptyEvents[0].payload.toString()).toBe("after rotation");
  });

  it("shouldRotate returns true when file exceeds threshold", () => {
    const store = new EventStore(eventsPath, 100);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
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

  it("close releases fd without deleting file", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("session data"));
    store.close();

    // events.bin 仍然存在，数据目录由 serve 的 onSessionRemoved 统一清理
    expect(existsSync(eventsPath)).toBe(true);

    // 验证文件内容完整
    const data = readFileSync(eventsPath);
    expect(data.subarray(0, 4).toString("ascii")).toBe("CCAE");
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
    store.appendSnapshot("the snapshot", 80, 24);
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

describe("EventStore: edge cases", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eventstore-edge-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("open auto-creates parent directory if it does not exist", () => {
    const nestedPath = join(tmpDir, "deep", "nested", "session", "events.bin");
    const store = new EventStore(nestedPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-mkdir", createdAt: "2026-01-01T00:00:00Z" });
    expect(existsSync(nestedPath)).toBe(true);
    store.closeSync();
  });

  it("findLatestSnapshot returns null for file with only header", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    // METADATA is written on open, but no SNAPSHOT
    store.closeSync();
    const result = EventStore.findLatestSnapshot(eventsPath);
    expect(result).toBeNull();
  });

  it("handles large payload (64KB) correctly", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    const largeData = Buffer.alloc(64 * 1024, 0x42); // 64KB of 'B'
    store.appendPtyData(largeData);
    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    const ptyEvents = events.filter((e) => e.type === EventType.PTY_DATA);
    expect(ptyEvents.length).toBe(1);
    expect(ptyEvents[0].payload.length).toBe(64 * 1024);
    expect(ptyEvents[0].payload[0]).toBe(0x42);
    expect(ptyEvents[0].payload[65535]).toBe(0x42);
  });

  it("snapshot does not clear history events (D-47)", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("before-1"));
    store.appendPtyData(Buffer.from("before-2"));
    store.appendSnapshot("snap", 80, 24);
    store.appendPtyData(Buffer.from("after-1"));
    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    const ptyEvents = events.filter((e) => e.type === EventType.PTY_DATA);
    // 快照前后的 PTY_DATA 都应保留
    expect(ptyEvents.length).toBe(3);
    expect(ptyEvents[0].payload.toString()).toBe("before-1");
    expect(ptyEvents[1].payload.toString()).toBe("before-2");
    expect(ptyEvents[2].payload.toString()).toBe("after-1");
  });

  it("shouldSnapshot fires correctly after rotation resets eventCount", () => {
    const store = new EventStore(eventsPath, 50);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    store.appendPtyData(Buffer.alloc(200, 0x41));
    expect(store.shouldRotate()).toBe(true);
    store.rotate("snap-rotate", 80, 24);

    // rotation 后 eventCount = 2, 写 97 个事件到 eventCount = 99
    for (let i = 0; i < 97; i++) {
      store.appendPtyData(Buffer.from("x"));
    }
    expect(store.shouldSnapshot()).toBe(false); // eventCount = 99

    store.appendPtyData(Buffer.from("x")); // eventCount = 100
    expect(store.shouldSnapshot()).toBe(true);

    store.closeSync();
  });

  it("findLatestSnapshot handles truncated file gracefully", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });
    store.appendPtyData(Buffer.from("data"));
    store.appendSnapshot("snap", 80, 24);
    store.closeSync();

    // 截断文件：删掉最后 2 个字节破坏 trailer
    const data = readFileSync(eventsPath);
    const { writeFileSync: writeFS } = require("node:fs");
    writeFS(eventsPath, data.subarray(0, data.length - 2));

    // 不应崩溃，返回 null 或能处理
    const result = EventStore.findLatestSnapshot(eventsPath);
    // 截断后 totalLen 读取的值不正确，reverse scan 应在边界检查处停止
    // 具体行为取决于截断位置，但不应抛异常
    expect(() => EventStore.findLatestSnapshot(eventsPath)).not.toThrow();
  });
});
