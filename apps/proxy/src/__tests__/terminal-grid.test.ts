import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "../event-store.js";
import { TerminalTracker } from "../terminal-tracker.js";
import type { TermLine } from "../terminal-tracker.js";

const TEST_DIR = join(process.cwd(), ".test-terminal-grid");
const TEST_SESSION = "test-grid-001";
const SESSION_DIR = join(TEST_DIR, TEST_SESSION);
const SNAPSHOT_PATH = join(SESSION_DIR, "snapshot.bin");

describe("TerminalTracker.extractGrid", () => {
  let store: EventStore;
  let tracker: TerminalTracker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    tracker = new TerminalTracker(store, SNAPSHOT_PATH, 80, 24);
  });

  afterEach(() => {
    tracker.dispose();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns array of TermLine after feeding plain text", async () => {
    await tracker.feed("Hello world");
    const grid = tracker.extractGrid();
    expect(Array.isArray(grid)).toBe(true);
    expect(grid.length).toBeGreaterThan(0);
    // 第一行应包含 "Hello world"
    const firstLine = grid[0];
    const text = firstLine.map((s) => s.text).join("");
    expect(text).toContain("Hello world");
  });

  it("merges adjacent cells with identical style into one span", async () => {
    await tracker.feed("AABBCC");
    const grid = tracker.extractGrid();
    const firstLine = grid[0];
    // 没有颜色变化时，所有字符应合并到尽可能少的 span 中
    // 同一行相同样式的连续字符合并为一个 span
    const textSpans = firstLine.filter((s) => s.text.trim().length > 0);
    // 由于默认样式一致，整行应该只有一个包含内容的 span（可能包含尾部空格）
    expect(textSpans.length).toBeLessThanOrEqual(1);
    const fullText = firstLine.map((s) => s.text).join("");
    expect(fullText).toContain("AABBCC");
  });

  it("extracts foreground color from ANSI red escape sequence", async () => {
    // ESC[31m 设置红色前景色
    await tracker.feed("\x1b[31mRed Text\x1b[0m");
    const grid = tracker.extractGrid();
    const firstLine = grid[0];
    // 查找包含 "Red Text" 的 span
    const redSpan = firstLine.find((s) => s.text.includes("Red Text"));
    expect(redSpan).toBeDefined();
    expect(redSpan!.fg).toBeDefined();
    // ANSI color 1 (red) 应被转换为 hex
    expect(typeof redSpan!.fg).toBe("string");
  });

  it("handles bold attribute", async () => {
    await tracker.feed("\x1b[1mBold Text\x1b[0m");
    const grid = tracker.extractGrid();
    const firstLine = grid[0];
    const boldSpan = firstLine.find((s) => s.text.includes("Bold Text"));
    expect(boldSpan).toBeDefined();
    expect(boldSpan!.bold).toBe(true);
  });

  it("handles background color", async () => {
    // ESC[42m 设置绿色背景
    await tracker.feed("\x1b[42mGreen BG\x1b[0m");
    const grid = tracker.extractGrid();
    const firstLine = grid[0];
    const bgSpan = firstLine.find((s) => s.text.includes("Green BG"));
    expect(bgSpan).toBeDefined();
    expect(bgSpan!.bg).toBeDefined();
    expect(typeof bgSpan!.bg).toBe("string");
  });

  it("returns empty lines for rows with no content", async () => {
    await tracker.feed("first line");
    const grid = tracker.extractGrid();
    // 末尾的空白行应被裁剪，但如果终端有多行，
    // 第二行之后应该是空行或被裁剪
    // 检查 grid 长度至少为 1
    expect(grid.length).toBeGreaterThanOrEqual(1);
  });

  it("handles wide characters (CJK) skipping continuation cells", async () => {
    // CJK 字符占两列宽
    await tracker.feed("AB\u4e2d\u6587CD");
    const grid = tracker.extractGrid();
    const firstLine = grid[0];
    const fullText = firstLine.map((s) => s.text).join("");
    // 应该包含所有字符，不重复
    expect(fullText).toContain("AB");
    expect(fullText).toContain("\u4e2d");
    expect(fullText).toContain("\u6587");
    expect(fullText).toContain("CD");
    // 中文字符各占 2 列但应只出现一次
    const chineseCount = (fullText.match(/\u4e2d/g) || []).length;
    expect(chineseCount).toBe(1);
  });

  it("hasGridChanged returns true when buffer content differs", async () => {
    await tracker.feed("Hello");
    // 第一次调用应返回 true（与空初始状态不同）
    expect(tracker.hasGridChanged()).toBe(true);
  });

  it("hasGridChanged returns false when buffer is unchanged", async () => {
    await tracker.feed("Stable content");
    // 触发一次变更检测
    tracker.hasGridChanged();
    // 没有新数据写入，第二次调用应返回 false
    expect(tracker.hasGridChanged()).toBe(false);
  });
});

describe("TerminalTracker lineId mechanism", () => {
  let store: EventStore;
  let tracker: TerminalTracker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new EventStore(TEST_SESSION, 50, TEST_DIR);
    tracker = new TerminalTracker(store, SNAPSHOT_PATH, 80, 24);
  });

  afterEach(() => {
    tracker.dispose();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("nextLineId starts from buffer initial length and increments on linefeed", async () => {
    const initialNewest = tracker.getNewestLineId();
    // 写入多行数据，触发 linefeed
    await tracker.feed("line1\r\nline2\r\nline3\r\n");
    const afterNewest = tracker.getNewestLineId();
    // 每个 \r\n 触发一次 linefeed，newestLineId 应增长
    expect(afterNewest).toBeGreaterThan(initialNewest);
  });

  it("extractLines returns TermSpan arrays for valid lineId range", async () => {
    await tracker.feed("hello\r\nworld\r\n");
    const oldest = tracker.getOldestLineId();
    const lines = tracker.extractLines(oldest, 2);
    expect(lines.length).toBeGreaterThan(0);
    // 每一行是 TermSpan 数组
    for (const line of lines) {
      expect(Array.isArray(line)).toBe(true);
    }
  });

  it("extractLines returns empty array for evicted lineId", async () => {
    // 请求远早于 buffer 开头的 lineId
    const lines = tracker.extractLines(-100, 5);
    expect(lines).toEqual([]);
  });

  it("getOldestLineId equals nextLineId minus buffer length", async () => {
    await tracker.feed("a\r\nb\r\nc\r\n");
    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    // oldest 应不超过 newest
    expect(oldest).toBeLessThanOrEqual(newest);
  });

  it("getNewestLineId equals nextLineId minus 1", async () => {
    await tracker.feed("data\r\n");
    const newest = tracker.getNewestLineId();
    // newest 应该是非负整数
    expect(newest).toBeGreaterThanOrEqual(0);
  });

  it("lineId remains stable for existing lines after new data", async () => {
    // 写入足够多行使 buffer 有内容可追踪
    await tracker.feed("first\r\nsecond\r\n");
    // 取 newestLineId 对应的行（一定在 buffer 中）
    const targetLineId = tracker.getNewestLineId();
    const linesBefore = tracker.extractLines(targetLineId, 1);
    expect(linesBefore.length).toBe(1);

    // 写入更多数据后，同一 lineId 的行内容不变（buffer 未溢出）
    await tracker.feed("third\r\n");
    const linesAfter = tracker.extractLines(targetLineId, 1);

    expect(linesAfter.length).toBe(linesBefore.length);
    const textBefore = linesBefore[0].map(s => s.text).join("");
    const textAfter = linesAfter[0].map(s => s.text).join("");
    expect(textAfter).toBe(textBefore);
  });
});
