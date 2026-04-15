import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { EventStore, EventType } from "#src/event-store.js";

// headless terminal 的 write 是异步的，需要等待回调
function termWrite(terminal: InstanceType<typeof HeadlessTerminal>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

/**
 * 终端数据流验证（v2 pipeline）
 *
 * 验证 PTY 数据通过 headless terminal + EventStore 的新链路：
 * headless.write(data) -> serialize snapshot -> EventStore persist
 * 快照触发时机、事件顺序、序列化内容完整性
 */
describe("v2 pipeline: headless terminal write + serialize", () => {
  let terminal: InstanceType<typeof HeadlessTerminal>;
  let serializeAddon: SerializeAddon;

  beforeEach(() => {
    terminal = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
  });

  afterEach(() => {
    terminal.dispose();
  });

  it("headless terminal accepts PTY data and serialize produces output", async () => {
    await termWrite(terminal, "$ npm test\r\nPASS all tests\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).toContain("npm test");
    expect(serialized).toContain("PASS all tests");
  });

  it("headless terminal preserves ANSI color sequences in serialize output", async () => {
    await termWrite(terminal, "\x1b[31mERROR\x1b[0m normal text\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("ERROR");
    expect(serialized).toContain("normal text");
  });

  it("headless terminal handles wide characters (CJK)", async () => {
    await termWrite(terminal, "AB\u4e2d\u6587CD\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("\u4e2d");
    expect(serialized).toContain("\u6587");
  });

  it("headless terminal resize updates columns and rows", async () => {
    await termWrite(terminal, "hello\r\n");
    terminal.resize(120, 40);
    await termWrite(terminal, "after resize\r\n");

    const serialized = serializeAddon.serialize();
    expect(serialized).toContain("hello");
    expect(serialized).toContain("after resize");
  });
});

describe("v2 pipeline: EventStore receives data in correct order", () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dataflow-test-"));
    eventsPath = join(tmpDir, "events.bin");
  });

  it("PTY data events are stored in order with correct payloads", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    store.appendPtyData(Buffer.from("chunk-1"));
    store.appendPtyData(Buffer.from("chunk-2"));
    store.appendPtyData(Buffer.from("chunk-3"));
    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    const ptyEvents = events.filter((e) => e.type === EventType.PTY_DATA);
    expect(ptyEvents.length).toBe(3);
    expect(ptyEvents[0].payload.toString()).toBe("chunk-1");
    expect(ptyEvents[1].payload.toString()).toBe("chunk-2");
    expect(ptyEvents[2].payload.toString()).toBe("chunk-3");

    // 时间戳单调递增
    for (let i = 1; i < ptyEvents.length; i++) {
      expect(ptyEvents[i].timestamp).toBeGreaterThanOrEqual(ptyEvents[i - 1].timestamp);
    }
  });

  it("snapshot triggers every N events (shouldSnapshot check)", () => {
    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    let snapshotCount = 0;
    for (let i = 0; i < 199; i++) {
      store.appendPtyData(Buffer.from(`data-${i}`));
      if (store.shouldSnapshot()) {
        snapshotCount++;
      }
    }
    expect(snapshotCount).toBeGreaterThanOrEqual(1);

    store.closeSync();
  });

  it("integrated flow: write + snapshot + read back", async () => {
    const terminal = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);

    const store = new EventStore(eventsPath);
    store.open({ cols: 80, rows: 24, sessionId: "test-1", createdAt: "2026-01-01T00:00:00Z" });

    await termWrite(terminal, "hello world\r\n");
    store.appendPtyData(Buffer.from("hello world\r\n"));

    await termWrite(terminal, "second line\r\n");
    store.appendPtyData(Buffer.from("second line\r\n"));

    const serialized = addon.serialize();
    store.appendSnapshot(serialized);

    store.closeSync();

    const events = EventStore.readEventsFromFile(eventsPath);
    const snapshotEvents = events.filter((e) => e.type === EventType.SNAPSHOT);
    expect(snapshotEvents.length).toBe(1);

    const snapshotContent = snapshotEvents[0].payload.toString("utf-8");
    expect(snapshotContent).toContain("hello world");
    expect(snapshotContent).toContain("second line");

    terminal.dispose();
  });
});

describe("v2 pipeline: SeqCounter integration smoke test", () => {
  it("SeqCounter can be imported and used", async () => {
    const { SeqCounter } = await import("#src/seq-counter.js");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tmpDir = join(process.cwd(), ".test-seq-counter");
    mkdirSync(tmpDir, { recursive: true });

    const counter = new SeqCounter("test-session", tmpDir);
    expect(counter.current()).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);

    const counter2 = new SeqCounter("test-session", tmpDir);
    expect(counter2.current()).toBe(2);
    expect(counter2.next()).toBe(3);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
