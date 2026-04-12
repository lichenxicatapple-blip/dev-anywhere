import { describe, it, expect } from "vitest";
import { createFrameCache } from "../../frame-cache.js";

const span = (text: string) => ({ text });

describe("createFrameCache", () => {
  it("full 帧直接存储，getFullFrame 返回完整 JSON", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("hello")], [span("world")]],
      cursor: { x: 0, y: 1 },
    });

    const result = JSON.parse(cache.getFullFrame("s1")!);
    expect(result.type).toBe("terminal_frame");
    expect(result.sessionId).toBe("s1");
    expect(result.payload.mode).toBe("full");
    expect(result.payload.lines).toHaveLength(2);
    expect(result.payload.lines[0][0].text).toBe("hello");
    expect(result.payload.lines[1][0].text).toBe("world");
  });

  it("delta 帧 merge 到已有 full 基底", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("line0")], [span("line1")], [span("line2")]],
      cursor: { x: 0, y: 0 },
    });

    // delta 只更新第 1 行
    cache.apply("s1", {
      mode: "delta",
      lines: [{ lineIndex: 1, spans: [span("updated")] }],
      cursor: { x: 5, y: 1 },
    });

    const result = JSON.parse(cache.getFullFrame("s1")!);
    expect(result.payload.lines[0][0].text).toBe("line0");
    expect(result.payload.lines[1][0].text).toBe("updated");
    expect(result.payload.lines[2][0].text).toBe("line2");
    expect(result.payload.cursor).toEqual({ x: 5, y: 1 });
  });

  it("delta 扩展 grid 行数", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("line0")]],
      cursor: { x: 0, y: 0 },
    });

    // delta 写入第 3 行，中间自动填充空行
    cache.apply("s1", {
      mode: "delta",
      lines: [{ lineIndex: 3, spans: [span("line3")] }],
      cursor: { x: 0, y: 3 },
    });

    const result = JSON.parse(cache.getFullFrame("s1")!);
    expect(result.payload.lines).toHaveLength(4);
    expect(result.payload.lines[1]).toEqual([]);
    expect(result.payload.lines[2]).toEqual([]);
    expect(result.payload.lines[3][0].text).toBe("line3");
  });

  it("没有 full 基底时 delta 被忽略", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "delta",
      lines: [{ lineIndex: 0, spans: [span("orphan")] }],
      cursor: { x: 0, y: 0 },
    });

    expect(cache.getFullFrame("s1")).toBeNull();
  });

  it("多次 delta 累积 merge", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("a")], [span("b")], [span("c")]],
      cursor: { x: 0, y: 0 },
    });

    cache.apply("s1", {
      mode: "delta",
      lines: [{ lineIndex: 0, spans: [span("A")] }],
      cursor: { x: 1, y: 0 },
    });
    cache.apply("s1", {
      mode: "delta",
      lines: [{ lineIndex: 2, spans: [span("C")] }],
      cursor: { x: 1, y: 2 },
    });

    const result = JSON.parse(cache.getFullFrame("s1")!);
    expect(result.payload.lines[0][0].text).toBe("A");
    expect(result.payload.lines[1][0].text).toBe("b");
    expect(result.payload.lines[2][0].text).toBe("C");
  });

  it("remove 清除缓存", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("x")]],
      cursor: { x: 0, y: 0 },
    });
    cache.remove("s1");
    expect(cache.getFullFrame("s1")).toBeNull();
  });

  it("不同 session 互不干扰", () => {
    const cache = createFrameCache();
    cache.apply("s1", {
      mode: "full",
      lines: [[span("session1")]],
      cursor: { x: 0, y: 0 },
    });
    cache.apply("s2", {
      mode: "full",
      lines: [[span("session2")]],
      cursor: { x: 0, y: 0 },
    });

    const r1 = JSON.parse(cache.getFullFrame("s1")!);
    const r2 = JSON.parse(cache.getFullFrame("s2")!);
    expect(r1.payload.lines[0][0].text).toBe("session1");
    expect(r2.payload.lines[0][0].text).toBe("session2");
    expect(r1.sessionId).toBe("s1");
    expect(r2.sessionId).toBe("s2");
  });
});
