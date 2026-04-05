import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore, EventType } from "../event-store.js";
import { TerminalTracker } from "../terminal-tracker.js";

const TEST_DIR = join(process.cwd(), ".test-terminal-tracker");
const TEST_SESSION = "test-tracker-001";
const SESSION_DIR = join(TEST_DIR, TEST_SESSION);
const SNAPSHOT_PATH = join(SESSION_DIR, "snapshot.bin");

describe("TerminalTracker", () => {
  let store: EventStore;
  let tracker: TerminalTracker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    tracker = new TerminalTracker(store, SNAPSHOT_PATH);
  });

  afterEach(() => {
    tracker.dispose();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("starts with eventsSinceSnapshot at 0", () => {
    expect(tracker.shouldSnapshot()).toBe(false);
  });

  it("shouldSnapshot returns true after 100 feeds", async () => {
    for (let i = 0; i < 100; i++) {
      await tracker.feed("x");
    }
    expect(tracker.shouldSnapshot()).toBe(true);
  });

  it("shouldSnapshot returns false before 100 feeds", async () => {
    for (let i = 0; i < 99; i++) {
      await tracker.feed("x");
    }
    expect(tracker.shouldSnapshot()).toBe(false);
  });

  it("takeSnapshot resets event counter", async () => {
    for (let i = 0; i < 100; i++) {
      await tracker.feed("x");
    }
    expect(tracker.shouldSnapshot()).toBe(true);
    tracker.takeSnapshot();
    expect(tracker.shouldSnapshot()).toBe(false);
  });

  it("takeSnapshot writes snapshot event to EventStore", async () => {
    await tracker.feed("hello world");
    tracker.takeSnapshot();

    const events = store.readEvents();
    const snapshots = events.filter((e) => e.type === EventType.SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload.length).toBeGreaterThan(0);
  });

  it("takeSnapshot creates snapshot.bin file", async () => {
    await tracker.feed("some terminal output");
    tracker.takeSnapshot();

    expect(existsSync(SNAPSHOT_PATH)).toBe(true);
  });

  it("onStateChange triggers snapshot on working to idle", async () => {
    await tracker.feed("output data");
    tracker.onStateChange("working", "idle");

    const events = store.readEvents();
    const snapshots = events.filter((e) => e.type === EventType.SNAPSHOT);
    expect(snapshots).toHaveLength(1);
  });

  it("onStateChange does not trigger on other transitions", async () => {
    await tracker.feed("output data");
    tracker.onStateChange("idle", "working");
    tracker.onStateChange("working", "error");

    const events = store.readEvents();
    const snapshots = events.filter((e) => e.type === EventType.SNAPSHOT);
    expect(snapshots).toHaveLength(0);
  });

  it("snapshot contains terminal content", async () => {
    await tracker.feed("Hello, terminal!");
    tracker.takeSnapshot();

    const snapshot = store.getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    const content = snapshot!.payload.toString();
    expect(content).toContain("Hello, terminal!");
  });

  it("handles ANSI sequences in feed", async () => {
    await tracker.feed("\x1b[1mBold text\x1b[0m");
    await tracker.feed("\x1b[31mRed text\x1b[0m");
    tracker.takeSnapshot();

    const snapshot = store.getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    const content = snapshot!.payload.toString();
    expect(content).toContain("Bold text");
    expect(content).toContain("Red text");
  });
});
