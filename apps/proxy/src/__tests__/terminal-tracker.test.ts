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

  it("snapshot + post-snapshot events reproduce final state", async () => {
    // 快照前：喂数据到虚拟终端 + 写入 EventStore（模拟 serve 的行为）
    const preData1 = "Line 1: hello\r\n";
    const preData2 = "Line 2: world\r\n";
    await tracker.feed(preData1);
    store.append(EventType.PTY_OUTPUT, preData1);
    store.flush();
    await tracker.feed(preData2);
    store.append(EventType.PTY_OUTPUT, preData2);
    store.flush();

    tracker.takeSnapshot();

    // 快照后：继续喂数据
    const postData1 = "Line 3: after snapshot\r\n";
    const postData2 = "\x1b[1mLine 4: bold\x1b[0m\r\n";
    await tracker.feed(postData1);
    store.append(EventType.PTY_OUTPUT, postData1);
    store.flush();
    await tracker.feed(postData2);
    store.append(EventType.PTY_OUTPUT, postData2);
    store.flush();

    const snapshot = store.getLatestSnapshot();
    expect(snapshot).not.toBeNull();

    // 快照之后的事件
    const postSnapshotEvents = store.readEvents(snapshot!.seq);
    expect(postSnapshotEvents.length).toBeGreaterThan(0);

    // 新建终端，加载快照，回放后续事件
    const pkg = await import("@xterm/headless");
    const serializePkg = await import("@xterm/addon-serialize");
    const restoreTerminal = new pkg.default.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    const restoreSerialize = new serializePkg.default.SerializeAddon();
    restoreTerminal.loadAddon(restoreSerialize);

    await new Promise<void>((resolve) => {
      restoreTerminal.write(snapshot!.payload.toString(), () => resolve());
    });

    for (const event of postSnapshotEvents) {
      if (event.type === EventType.PTY_OUTPUT) {
        await new Promise<void>((resolve) => {
          restoreTerminal.write(event.payload.toString(), () => resolve());
        });
      }
    }

    // 恢复后的终端应该包含快照后的内容
    const restored = restoreSerialize.serialize({ scrollback: 0 });
    expect(restored).toContain("Line 3: after snapshot");
    expect(restored).toContain("Line 4: bold");

    restoreTerminal.dispose();
  });
});
