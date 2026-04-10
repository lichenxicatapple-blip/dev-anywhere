import { describe, it, expect, beforeEach } from "vitest";
import {
  TerminalFrameRenderer,
  renderLineToAnsi,
  type TerminalFrame,
  type TermLine,
} from "#src/terminal-frame-renderer.js";

function makeFrame(payload: TerminalFrame["payload"]): TerminalFrame {
  return { type: "terminal_frame", sessionId: "s1", payload };
}

describe("TerminalFrameRenderer: applyFrame", () => {
  let renderer: TerminalFrameRenderer;

  beforeEach(() => {
    renderer = new TerminalFrameRenderer();
  });

  it("full frame replaces entire viewport", () => {
    const lines: TermLine[] = [
      [{ text: "line 0" }],
      [{ text: "line 1" }],
    ];
    renderer.applyFrame(makeFrame({ mode: "full", lines }));

    const viewport = renderer.getViewportLines();
    expect(viewport).toHaveLength(2);
    expect(viewport[0][0].text).toBe("line 0");
    expect(viewport[1][0].text).toBe("line 1");
  });

  it("delta frame updates specific lines", () => {
    // 先 full 建立基准
    renderer.applyFrame(makeFrame({
      mode: "full",
      lines: [[{ text: "A" }], [{ text: "B" }], [{ text: "C" }]],
    }));

    // delta 只改第 1 行
    renderer.applyFrame(makeFrame({
      mode: "delta",
      lines: [{ lineIndex: 1, spans: [{ text: "B updated" }] }],
    }));

    const viewport = renderer.getViewportLines();
    expect(viewport[0][0].text).toBe("A");
    expect(viewport[1][0].text).toBe("B updated");
    expect(viewport[2][0].text).toBe("C");
  });

  it("delta frame expands viewport if lineIndex exceeds current length", () => {
    renderer.applyFrame(makeFrame({ mode: "full", lines: [[{ text: "A" }]] }));
    renderer.applyFrame(makeFrame({
      mode: "delta",
      lines: [{ lineIndex: 3, spans: [{ text: "D" }] }],
    }));

    const viewport = renderer.getViewportLines();
    expect(viewport.length).toBe(4);
    expect(viewport[3][0].text).toBe("D");
    // 中间行填充为空数组
    expect(viewport[1]).toEqual([]);
    expect(viewport[2]).toEqual([]);
  });

  it("saves cursor position from frame payload", () => {
    expect(renderer.cursor).toBeNull();

    renderer.applyFrame(makeFrame({
      mode: "full",
      lines: [[{ text: "x" }]],
      cursor: { x: 5, y: 3 },
    }));

    expect(renderer.cursor).toEqual({ x: 5, y: 3 });
  });

  it("fires onChange callback on applyFrame", () => {
    let callCount = 0;
    renderer.onUpdate(() => callCount++);

    renderer.applyFrame(makeFrame({ mode: "full", lines: [[{ text: "x" }]] }));
    renderer.applyFrame(makeFrame({ mode: "delta", lines: [{ lineIndex: 0, spans: [{ text: "y" }] }] }));

    expect(callCount).toBe(2);
  });
});

describe("TerminalFrameRenderer: scrollback cache", () => {
  let renderer: TerminalFrameRenderer;

  beforeEach(() => {
    renderer = new TerminalFrameRenderer();
  });

  it("applyLinesResponse populates cache and updates lineId bounds", () => {
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 10,
      oldestLineId: 0,
      newestLineId: 100,
      lines: [[{ text: "line 10" }], [{ text: "line 11" }]],
    });

    expect(renderer.cacheSize).toBe(2);
    expect(renderer.oldestLineId).toBe(0);
    expect(renderer.newestLineId).toBe(100);
  });

  it("getCachedLines returns cached lines and null for uncached", () => {
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 5,
      oldestLineId: 0,
      newestLineId: 50,
      lines: [[{ text: "five" }], [{ text: "six" }]],
    });

    const result = renderer.getCachedLines(4, 4);
    expect(result[0]).toBeNull();        // lineId 4 not cached
    expect(result[1]![0].text).toBe("five");  // lineId 5
    expect(result[2]![0].text).toBe("six");   // lineId 6
    expect(result[3]).toBeNull();        // lineId 7 not cached
  });

  it("getMissingRange returns null when cache fully covers request", () => {
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 0,
      oldestLineId: 0,
      newestLineId: 10,
      lines: [[{ text: "0" }], [{ text: "1" }], [{ text: "2" }]],
    });

    const missing = renderer.getMissingRange(0, 3);
    expect(missing).toBeNull();
  });

  it("getMissingRange returns narrowed range for partial cache hit", () => {
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 2,
      oldestLineId: 0,
      newestLineId: 10,
      lines: [[{ text: "2" }], [{ text: "3" }]],
    });

    // 请求 0-4，0/1/4 缺失，2/3 已缓存
    const missing = renderer.getMissingRange(0, 5);
    expect(missing).toEqual({ fromLineId: 0, count: 5 });
  });

  it("getMissingRange returns full range when no cache", () => {
    const missing = renderer.getMissingRange(10, 20);
    expect(missing).toEqual({ fromLineId: 10, count: 20 });
  });

  it("clearCache resets all state", () => {
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 0,
      oldestLineId: 0,
      newestLineId: 5,
      lines: [[{ text: "x" }]],
    });
    renderer.setScrollPosition(3);

    expect(renderer.cacheSize).toBe(1);
    expect(renderer.scrollPosition).toBe(3);

    renderer.clearCache();

    expect(renderer.cacheSize).toBe(0);
    expect(renderer.scrollPosition).toBeNull();
  });
});

describe("renderLineToAnsi", () => {
  it("renders plain text without escape codes", () => {
    const result = renderLineToAnsi([{ text: "hello" }]);
    expect(result).toBe("hello");
  });

  it("renders bold text with SGR 1", () => {
    const result = renderLineToAnsi([{ text: "bold", bold: true }]);
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("bold");
    expect(result).toContain("\x1b[0m");
  });

  it("renders dim, italic, underline, strikethrough", () => {
    const result = renderLineToAnsi([{
      text: "styled",
      dim: true,
      italic: true,
      underline: true,
      strikethrough: true,
    }]);
    expect(result).toContain("\x1b[2m"); // dim
    expect(result).toContain("\x1b[3m"); // italic
    expect(result).toContain("\x1b[4m"); // underline
    expect(result).toContain("\x1b[9m"); // strikethrough
    expect(result).toContain("\x1b[0m"); // reset
  });

  it("renders fg color as 24-bit ANSI", () => {
    const result = renderLineToAnsi([{ text: "red", fg: "#ff0000" }]);
    expect(result).toContain("\x1b[38;2;255;0;0m");
  });

  it("renders bg color as 24-bit ANSI", () => {
    const result = renderLineToAnsi([{ text: "bg", bg: "#00ff00" }]);
    expect(result).toContain("\x1b[48;2;0;255;0m");
  });

  it("renders multiple spans sequentially", () => {
    const result = renderLineToAnsi([
      { text: "plain " },
      { text: "colored", fg: "#0000ff" },
      { text: " end" },
    ]);
    expect(result).toContain("plain ");
    expect(result).toContain("\x1b[38;2;0;0;255m");
    expect(result).toContain("colored");
    expect(result).toContain(" end");
  });
});
