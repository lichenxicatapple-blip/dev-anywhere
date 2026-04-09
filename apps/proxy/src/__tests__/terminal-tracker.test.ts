import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TerminalTracker } from "../terminal-tracker.js";

describe("TerminalTracker", () => {
  let tracker: TerminalTracker;

  beforeEach(() => {
    tracker = new TerminalTracker(80, 24);
  });

  afterEach(() => {
    tracker.dispose();
  });

  it("feed writes data to xterm buffer", async () => {
    await tracker.feed("hello world\r\n");
    const grid = tracker.extractGrid();
    expect(grid.length).toBeGreaterThan(0);
    expect(grid[0].some((span) => span.text.includes("hello world"))).toBe(true);
  });

  it("handles ANSI sequences in feed", async () => {
    await tracker.feed("\x1b[1mBold text\x1b[0m\r\n");
    await tracker.feed("\x1b[31mRed text\x1b[0m\r\n");
    const grid = tracker.extractGrid();
    const texts = grid.flatMap((line) => line.map((s) => s.text));
    expect(texts.some((t) => t.includes("Bold text"))).toBe(true);
    expect(texts.some((t) => t.includes("Red text"))).toBe(true);
  });

  it("resize changes terminal dimensions", async () => {
    tracker.resize(40, 10);
    await tracker.feed("after resize\r\n");
    const grid = tracker.extractGrid();
    expect(grid.length).toBeGreaterThan(0);
  });

  it("hasGridChanged detects content changes", async () => {
    // 首次调用总是 true（初始 hash 为空）
    tracker.hasGridChanged();
    await tracker.feed("new content\r\n");
    expect(tracker.hasGridChanged()).toBe(true);
  });

  it("hasGridChanged returns false when nothing changed", async () => {
    await tracker.feed("static\r\n");
    tracker.hasGridChanged(); // 记录当前 hash
    expect(tracker.hasGridChanged()).toBe(false);
  });

  it("scrollback is set to 10000", async () => {
    // 写入足够数据验证 scrollback 不会在 1000 行时截断
    for (let i = 0; i < 1100; i++) {
      await tracker.feed(`line ${i}\r\n`);
    }
    // 如果 scrollback 只有 1000，最早的行会被丢弃
    // 用 lineId 验证最早行仍可访问
    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    expect(newest - oldest + 1).toBeGreaterThan(1100);
  });
});
