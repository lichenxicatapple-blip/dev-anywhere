import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFramePusher, FRAME_PUSH_INTERVAL_MS } from "#src/frame-pusher.js";
import type { TerminalTracker, TermLine } from "#src/terminal-tracker.js";

function makeSpan(text: string, fg?: string, bold?: boolean) {
  return { text, ...(fg ? { fg } : {}), ...(bold ? { bold } : {}) };
}

function createMockTracker(overrides: Partial<TerminalTracker> = {}): TerminalTracker {
  return {
    hasGridChanged: vi.fn().mockReturnValue(true),
    extractGrid: vi.fn().mockReturnValue([[makeSpan("hello")]]),
    getCursor: vi.fn().mockReturnValue({ x: 0, y: 0 }),
    ...overrides,
  } as unknown as TerminalTracker;
}

describe("frame-pusher: lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FRAME_PUSH_INTERVAL_MS is 200ms (5fps)", () => {
    expect(FRAME_PUSH_INTERVAL_MS).toBe(200);
  });

  it("start begins 200ms interval, stop clears it", () => {
    let callCount = 0;
    const tracker = createMockTracker({
      // 每次返回不同 grid 以触发 delta 推送
      extractGrid: vi.fn().mockImplementation(() => {
        callCount++;
        return [[makeSpan(`frame-${callCount}`)]];
      }),
    });
    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(200);
    expect(sendFrame).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    expect(sendFrame).toHaveBeenCalledTimes(2);

    pusher.stop();
    vi.advanceTimersByTime(1000);
    // stop 后不再调用
    expect(sendFrame).toHaveBeenCalledTimes(2);
  });

  it("start resets lastGrid so next push is full mode", () => {
    const grid1: TermLine[] = [[makeSpan("first")]];
    const grid2: TermLine[] = [[makeSpan("second")]];
    let callCount = 0;
    const tracker = createMockTracker({
      extractGrid: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount <= 2 ? grid1 : grid2;
      }),
    });

    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    // 第一次 start + push
    pusher.start();
    vi.advanceTimersByTime(200);
    expect(JSON.parse(sendFrame.mock.calls[0][0]).payload.mode).toBe("full");

    // 再 push 一帧(无变化)
    vi.advanceTimersByTime(200);

    // 重新 start，应重置 lastGrid
    pusher.start();
    vi.advanceTimersByTime(200);
    const lastCall = sendFrame.mock.calls[sendFrame.mock.calls.length - 1][0];
    expect(JSON.parse(lastCall).payload.mode).toBe("full");

    pusher.stop();
  });
});

describe("frame-pusher: frame modes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first frame is full mode with complete grid", () => {
    const grid: TermLine[] = [
      [makeSpan("line 0")],
      [makeSpan("line 1", "#ff0000", true)],
    ];
    const tracker = createMockTracker({ extractGrid: vi.fn().mockReturnValue(grid) });
    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(200);

    const msg = JSON.parse(sendFrame.mock.calls[0][0]);
    expect(msg.type).toBe("terminal_frame");
    expect(msg.sessionId).toBe("s1");
    expect(msg.payload.mode).toBe("full");
    expect(msg.payload.lines).toEqual(grid);
    expect(msg.payload.cursor).toEqual({ x: 0, y: 0 });

    pusher.stop();
  });

  it("subsequent frame with changes is delta mode, only changed lines", () => {
    const grid1: TermLine[] = [[makeSpan("A")], [makeSpan("B")], [makeSpan("C")]];
    const grid2: TermLine[] = [[makeSpan("A")], [makeSpan("B changed")], [makeSpan("C")]];
    let callCount = 0;
    const tracker = createMockTracker({
      extractGrid: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? grid1 : grid2;
      }),
    });

    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(200); // full
    vi.advanceTimersByTime(200); // delta

    const delta = JSON.parse(sendFrame.mock.calls[1][0]);
    expect(delta.payload.mode).toBe("delta");
    expect(delta.payload.lines).toEqual([{ lineIndex: 1, spans: [makeSpan("B changed")] }]);

    pusher.stop();
  });

  it("no-op when hasGridChanged returns false", () => {
    const tracker = createMockTracker({ hasGridChanged: vi.fn().mockReturnValue(false) });
    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(600);

    expect(sendFrame).not.toHaveBeenCalled();
    pusher.stop();
  });

  it("no-op when grid changed flag is true but actual lines are identical", () => {
    const grid: TermLine[] = [[makeSpan("same")]];
    const tracker = createMockTracker({
      extractGrid: vi.fn().mockReturnValue(grid),
      hasGridChanged: vi.fn().mockReturnValue(true),
    });

    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(200); // full (first frame always sends)
    vi.advanceTimersByTime(200); // delta detection: same grid, no send

    // 首帧发送了，第二帧 grid 相同不发送
    expect(sendFrame).toHaveBeenCalledTimes(1);
    pusher.stop();
  });
});

describe("frame-pusher: flush", () => {
  it("flush forces an immediate push", () => {
    const tracker = createMockTracker();
    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    // 不 start，直接 flush
    pusher.flush();

    expect(sendFrame).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(sendFrame.mock.calls[0][0]);
    expect(msg.payload.mode).toBe("full");
  });
});

describe("frame-pusher: cursor position", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes cursor position from tracker in frame", () => {
    const tracker = createMockTracker({
      getCursor: vi.fn().mockReturnValue({ x: 5, y: 3 }),
    });
    const sendFrame = vi.fn();
    const pusher = createFramePusher({ tracker, sessionId: "s1", sendFrame });

    pusher.start();
    vi.advanceTimersByTime(200);

    const msg = JSON.parse(sendFrame.mock.calls[0][0]);
    expect(msg.payload.cursor).toEqual({ x: 5, y: 3 });

    pusher.stop();
  });
});
