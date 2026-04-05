import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore, EventType } from "../event-store.js";

const TEST_DIR = join(process.cwd(), ".test-event-store");
const TEST_SESSION = "test-session-001";
const SESSION_DIR = join(TEST_DIR, TEST_SESSION);

describe("EventStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates session data directory on construction", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    expect(existsSync(SESSION_DIR)).toBe(true);
    store.close();
  });

  it("starts with seq 0", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    expect(store.getSeq()).toBe(0);
    store.close();
  });

  it("increments seq on flush", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "hello");
    const seq = store.flush();
    expect(seq).toBe(1);
    expect(store.getSeq()).toBe(1);
    store.close();
  });

  it("buffers multiple appends into single event on flush", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "hello ");
    store.append(EventType.PTY_OUTPUT, "world");
    const seq = store.flush();
    expect(seq).toBe(1);

    const events = store.readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload.toString()).toBe("hello world");
    store.close();
  });

  it("reads events back in order", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "first");
    store.flush();
    store.append(EventType.PTY_OUTPUT, "second");
    store.flush();
    store.append(EventType.PTY_OUTPUT, "third");
    store.flush();

    const events = store.readEvents();
    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(1);
    expect(events[0].payload.toString()).toBe("first");
    expect(events[1].seq).toBe(2);
    expect(events[2].seq).toBe(3);
    expect(events[2].payload.toString()).toBe("third");
    store.close();
  });

  it("reads events after specified seq", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "a");
    store.flush();
    store.append(EventType.PTY_OUTPUT, "b");
    store.flush();
    store.append(EventType.PTY_OUTPUT, "c");
    store.flush();

    const events = store.readEvents(2);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(3);
    expect(events[0].payload.toString()).toBe("c");
    store.close();
  });

  it("restores seq from existing file on construction", () => {
    const store1 = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store1.append(EventType.PTY_OUTPUT, "data1");
    store1.flush();
    store1.append(EventType.PTY_OUTPUT, "data2");
    store1.flush();
    store1.close();

    const store2 = new EventStore(TEST_SESSION, 50, TEST_DIR);
    expect(store2.getSeq()).toBe(2);
    store2.append(EventType.PTY_OUTPUT, "data3");
    store2.flush();
    expect(store2.getSeq()).toBe(3);
    store2.close();
  });

  it("writes snapshot events directly without buffering", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "before");
    store.flush();

    const snapshotData = Buffer.from("terminal-state-snapshot");
    const seq = store.writeSnapshot(snapshotData);
    expect(seq).toBe(2);

    const events = store.readEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe(EventType.SNAPSHOT);
    expect(events[1].payload.toString()).toBe("terminal-state-snapshot");
    store.close();
  });

  it("getLatestSnapshot returns the most recent snapshot", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "data");
    store.flush();
    store.writeSnapshot(Buffer.from("snap1"));
    store.append(EventType.PTY_OUTPUT, "more data");
    store.flush();
    store.writeSnapshot(Buffer.from("snap2"));

    const latest = store.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.payload.toString()).toBe("snap2");
    store.close();
  });

  it("getLatestSnapshot returns null when no snapshots exist", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "data");
    store.flush();

    expect(store.getLatestSnapshot()).toBeNull();
    store.close();
  });

  it("handles binary payload correctly", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    const binary = Buffer.from([0x1b, 0x5b, 0x31, 0x6d, 0x00, 0xff, 0xfe]);
    store.append(EventType.PTY_OUTPUT, binary);
    store.flush();

    const events = store.readEvents();
    expect(events).toHaveLength(1);
    expect(Buffer.compare(events[0].payload, binary)).toBe(0);
    store.close();
  });

  it("cleanup removes all files", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "data");
    store.flush();
    store.writeSnapshot(Buffer.from("snap"));

    store.cleanup();

    expect(existsSync(join(SESSION_DIR, "events.bin"))).toBe(false);
    expect(existsSync(join(SESSION_DIR, "snapshot.bin"))).toBe(false);
  });

  it("flush with empty buffer returns current seq", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    expect(store.flush()).toBe(0);

    store.append(EventType.PTY_OUTPUT, "data");
    store.flush();
    expect(store.flush()).toBe(1);
    store.close();
  });

  it("preserves event timestamps", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    const before = Date.now();
    store.append(EventType.PTY_OUTPUT, "data");
    store.flush();
    const after = Date.now();

    const events = store.readEvents();
    expect(events[0].ts).toBeGreaterThanOrEqual(before);
    expect(events[0].ts).toBeLessThanOrEqual(after);
    store.close();
  });

  it("event type is preserved correctly", () => {
    const store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    store.append(EventType.PTY_OUTPUT, "output");
    store.flush();
    store.writeSnapshot(Buffer.from("snap"));
    store.append(EventType.PTY_INPUT, "input");
    store.flush(EventType.PTY_INPUT);

    const events = store.readEvents();
    expect(events[0].type).toBe(EventType.PTY_OUTPUT);
    expect(events[1].type).toBe(EventType.SNAPSHOT);
    expect(events[2].type).toBe(EventType.PTY_INPUT);
    store.close();
  });
});
