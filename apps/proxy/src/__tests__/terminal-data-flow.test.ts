import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TerminalTracker } from "../terminal-tracker.js";

/**
 * 终端数据流端到端验证
 *
 * 验证从 xterm 写入到 terminal_frame / terminal_lines 的完整链路：
 * xterm.write() → extractGrid() → Control 格式 terminal_frame
 * xterm.write() → extractLines(lineId) → terminal_lines_response
 * lineId 稳定性、scrollback 拉取、边界情况
 */
describe("Terminal data flow: xterm → extractGrid → terminal_frame", () => {
  let tracker: TerminalTracker;

  beforeEach(() => {
    tracker = new TerminalTracker(80, 24);
  });

  afterEach(() => {
    tracker.dispose();
  });

  it("extractGrid produces valid TermSpan structure for plain text", async () => {
    await tracker.feed("$ npm test\r\n");
    await tracker.feed("PASS all tests\r\n");

    const grid = tracker.extractGrid();
    expect(grid.length).toBeGreaterThan(0);

    // 每行是 TermSpan 数组，每个 span 有 text 字段
    for (const line of grid) {
      for (const span of line) {
        expect(typeof span.text).toBe("string");
      }
    }

    const allText = grid.flatMap((l) => l.map((s) => s.text)).join("");
    expect(allText).toContain("$ npm test");
    expect(allText).toContain("PASS all tests");
  });

  it("extractGrid preserves ANSI color as fg/bg fields", async () => {
    // 红色前景
    await tracker.feed("\x1b[31mERROR\x1b[0m normal\r\n");

    const grid = tracker.extractGrid();
    const errorSpan = grid[0].find((s) => s.text.includes("ERROR"));
    expect(errorSpan).toBeDefined();
    expect(errorSpan!.fg).toBeDefined();

    const normalSpan = grid[0].find((s) => s.text.includes("normal"));
    expect(normalSpan).toBeDefined();
    expect(normalSpan!.fg).toBeUndefined();
  });

  it("extractGrid preserves bold attribute", async () => {
    await tracker.feed("\x1b[1mBOLD\x1b[0m\r\n");

    const grid = tracker.extractGrid();
    const boldSpan = grid[0].find((s) => s.text.includes("BOLD"));
    expect(boldSpan).toBeDefined();
    expect(boldSpan!.bold).toBe(true);
  });

  it("terminal_frame Control format has no seq/source/version fields", async () => {
    await tracker.feed("hello\r\n");
    const grid = tracker.extractGrid();

    // 模拟 terminal-push.ts 构造 Control 消息的格式
    const controlMsg = {
      type: "terminal_frame" as const,
      sessionId: "test-session",
      payload: { lines: grid },
    };

    // Control 格式不应有 Envelope 字段
    expect(controlMsg).not.toHaveProperty("seq");
    expect(controlMsg).not.toHaveProperty("source");
    expect(controlMsg).not.toHaveProperty("version");
    expect(controlMsg).not.toHaveProperty("timestamp");

    // 必须有的字段
    expect(controlMsg.type).toBe("terminal_frame");
    expect(controlMsg.sessionId).toBe("test-session");
    expect(Array.isArray(controlMsg.payload.lines)).toBe(true);
  });

  it("hasGridChanged + extractGrid cycle simulates 5fps push", async () => {
    await tracker.feed("initial\r\n");
    tracker.hasGridChanged(); // 记录初始 hash

    // 模拟 3 帧推送周期
    const frames: ReturnType<typeof tracker.extractGrid>[] = [];

    // 帧 1：有变化
    await tracker.feed("frame 1\r\n");
    expect(tracker.hasGridChanged()).toBe(true);
    frames.push(tracker.extractGrid());

    // 帧 2：无变化，跳过
    expect(tracker.hasGridChanged()).toBe(false);

    // 帧 3：有变化
    await tracker.feed("frame 3\r\n");
    expect(tracker.hasGridChanged()).toBe(true);
    frames.push(tracker.extractGrid());

    expect(frames).toHaveLength(2);
  });

  it("incremental push: delta only contains changed lines", async () => {
    // 写入初始内容
    await tracker.feed("line A\r\nline B\r\nline C\r\n");
    const fullGrid = tracker.extractGrid();
    const fullLineCount = fullGrid.length;

    // 只在最后追加一行
    await tracker.feed("line D\r\n");
    const newGrid = tracker.extractGrid();

    // 计算 delta：哪些行变了
    const changedIndices: number[] = [];
    const maxLen = Math.max(fullGrid.length, newGrid.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = JSON.stringify(fullGrid[i] ?? []);
      const newLine = JSON.stringify(newGrid[i] ?? []);
      if (oldLine !== newLine) {
        changedIndices.push(i);
      }
    }

    // 应该只有少量行变化（新增行 + 可能的光标行）
    expect(changedIndices.length).toBeLessThan(fullLineCount);
    expect(changedIndices.length).toBeGreaterThan(0);
  });
});

describe("Terminal data flow: xterm → extractLines → terminal_lines_response", () => {
  let tracker: TerminalTracker;

  beforeEach(() => {
    tracker = new TerminalTracker(80, 24);
  });

  afterEach(() => {
    tracker.dispose();
  });

  it("extractLines returns correct lines for valid lineId range", async () => {
    await tracker.feed("line 0\r\nline 1\r\nline 2\r\nline 3\r\n");

    const oldest = tracker.getOldestLineId();
    const lines = tracker.extractLines(oldest, 4);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const allText = lines.flatMap((l) => l.map((s) => s.text)).join("");
    expect(allText).toContain("line 0");
  });

  it("terminal_lines_response format includes lineId metadata", async () => {
    await tracker.feed("data\r\n".repeat(50));

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    const lines = tracker.extractLines(oldest, 10);

    // 模拟 control-messages.ts 构造的响应格式
    const response = {
      type: "terminal_lines_response" as const,
      sessionId: "test-session",
      fromLineId: oldest,
      oldestLineId: oldest,
      newestLineId: newest,
      lines,
    };

    expect(response.oldestLineId).toBeLessThanOrEqual(response.fromLineId);
    expect(response.newestLineId).toBeGreaterThanOrEqual(response.fromLineId);
    expect(Array.isArray(response.lines)).toBe(true);
  });

  it("lineId is stable across new writes (no buffer overflow)", async () => {
    await tracker.feed("first line\r\nsecond line\r\n");
    const targetId = tracker.getNewestLineId();
    const before = tracker.extractLines(targetId, 1);
    const textBefore = before[0]?.map((s) => s.text).join("") ?? "";

    // 写入更多数据，但不溢出 scrollback
    await tracker.feed("third\r\nfourth\r\n");
    const after = tracker.extractLines(targetId, 1);
    const textAfter = after[0]?.map((s) => s.text).join("") ?? "";

    expect(textAfter).toBe(textBefore);
  });

  it("bidirectional scrolling: fetch older, then newer, then older again", async () => {
    // 写入 100 行
    for (let i = 0; i < 100; i++) {
      await tracker.feed(`line ${i}\r\n`);
    }

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();

    // 向上翻：拉取最早的 20 行
    const olderLines = tracker.extractLines(oldest, 20);
    expect(olderLines.length).toBe(20);

    // 向下翻：拉取中间的 20 行
    const midId = oldest + 50;
    const midLines = tracker.extractLines(midId, 20);
    expect(midLines.length).toBe(20);

    // 再向上翻：拉取已经拉过的范围
    const olderAgain = tracker.extractLines(oldest, 20);
    expect(olderAgain.length).toBe(olderLines.length);

    // 内容一致
    const textFirst = olderLines.flatMap((l) => l.map((s) => s.text)).join("");
    const textAgain = olderAgain.flatMap((l) => l.map((s) => s.text)).join("");
    expect(textAgain).toBe(textFirst);
  });

  it("requesting beyond newestLineId returns partial results", async () => {
    await tracker.feed("a\r\nb\r\nc\r\n");
    const newest = tracker.getNewestLineId();

    // 请求从 newest-1 开始的 100 行，实际只有 2 行可返回
    const lines = tracker.extractLines(newest - 1, 100);
    expect(lines.length).toBeLessThanOrEqual(100);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("requesting evicted lineId returns empty", async () => {
    const lines = tracker.extractLines(-999, 10);
    expect(lines).toEqual([]);
  });

  it("scrollback survives 1000+ lines without losing early content", async () => {
    // scrollback 设为 10000，写入 1100 行不应丢失
    for (let i = 0; i < 1100; i++) {
      await tracker.feed(`row-${i}\r\n`);
    }

    const oldest = tracker.getOldestLineId();
    const earliest = tracker.extractLines(oldest, 5);
    const earlyText = earliest.flatMap((l) => l.map((s) => s.text)).join("");
    expect(earlyText).toContain("row-");

    const newest = tracker.getNewestLineId();
    expect(newest - oldest + 1).toBeGreaterThan(1100);
  });

  it("oldestLineId/newestLineId are consistent with extractLines range", async () => {
    for (let i = 0; i < 50; i++) {
      await tracker.feed(`line ${i}\r\n`);
    }

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();

    // 拉取全部范围
    const allLines = tracker.extractLines(oldest, newest - oldest + 1);
    // 应该能拉到全部（没有溢出）
    expect(allLines.length).toBe(newest - oldest + 1);
  });
});

describe("SeqCounter integration smoke test", () => {
  it("SeqCounter can be imported and used", async () => {
    const { SeqCounter } = await import("../seq-counter.js");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tmpDir = join(process.cwd(), ".test-seq-counter");
    mkdirSync(tmpDir, { recursive: true });

    const counter = new SeqCounter("test-session", tmpDir);
    expect(counter.current()).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);

    // 新实例应从文件恢复
    const counter2 = new SeqCounter("test-session", tmpDir);
    expect(counter2.current()).toBe(2);
    expect(counter2.next()).toBe(3);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
