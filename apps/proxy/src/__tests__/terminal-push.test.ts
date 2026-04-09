import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTerminalPushHandler, FRAME_PUSH_INTERVAL_MS } from "../handlers/terminal-push.js";
import type { TerminalPushHandler } from "../handlers/terminal-push.js";
import type { TermLine, TermSpan } from "../terminal-tracker.js";
import type { Logger } from "pino";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

// 模拟 TerminalTracker
function createMockTracker(options: {
  hasGridChanged?: boolean;
  grid?: TermLine[];
}) {
  return {
    hasGridChanged: vi.fn().mockReturnValue(options.hasGridChanged ?? true),
    extractGrid: vi.fn().mockReturnValue(options.grid ?? []),
    feed: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("TerminalPushHandler", () => {
  let send: ReturnType<typeof vi.fn>;
  let logger: Logger;
  let handler: TerminalPushHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    logger = createMockLogger();
    handler = createTerminalPushHandler(send, logger);
  });

  afterEach(() => {
    handler.stopAll();
    vi.useRealTimers();
  });

  it("first push sends full grid with mode: full in Control format", () => {
    const grid: TermLine[] = [
      [{ text: "hello world" }],
      [{ text: "line 2", fg: "#ff0000", bold: true }],
    ];
    const tracker = createMockTracker({ hasGridChanged: true, grid });

    handler.start("sess-1", tracker as any);
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(send.mock.calls[0][0]);
    expect(msg.type).toBe("terminal_frame");
    expect(msg.sessionId).toBe("sess-1");
    // Control 格式没有 seq、source、version、timestamp 字段
    expect(msg.seq).toBeUndefined();
    expect(msg.source).toBeUndefined();
    expect(msg.version).toBeUndefined();
    expect(msg.timestamp).toBeUndefined();
    expect(msg.payload.mode).toBe("full");
    expect(msg.payload.lines).toEqual(grid);
  });

  it("subsequent push sends only changed lines with mode: delta", () => {
    const grid1: TermLine[] = [
      [{ text: "line 1" }],
      [{ text: "line 2" }],
      [{ text: "line 3" }],
    ];
    const grid2: TermLine[] = [
      [{ text: "line 1" }],        // unchanged
      [{ text: "line 2 CHANGED" }], // changed
      [{ text: "line 3" }],         // unchanged
    ];

    const tracker = createMockTracker({ hasGridChanged: true, grid: grid1 });
    handler.start("sess-1", tracker as any);

    // First tick: full frame
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    const firstEnvelope = JSON.parse(send.mock.calls[0][0]);
    expect(firstEnvelope.payload.mode).toBe("full");

    // Update grid for second tick
    tracker.extractGrid.mockReturnValue(grid2);

    // Second tick: delta frame
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    const deltaEnvelope = JSON.parse(send.mock.calls[1][0]);
    expect(deltaEnvelope.payload.mode).toBe("delta");
    expect(deltaEnvelope.payload.lines).toEqual([
      { lineIndex: 1, spans: [{ text: "line 2 CHANGED" }] },
    ]);
  });

  it("skips push when grid has not changed", () => {
    const tracker = createMockTracker({ hasGridChanged: false });

    handler.start("sess-1", tracker as any);
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);

    expect(send).not.toHaveBeenCalled();
    expect(tracker.hasGridChanged).toHaveBeenCalled();
    expect(tracker.extractGrid).not.toHaveBeenCalled();
  });

  it("stop clears interval and prevents further pushes", () => {
    const tracker = createMockTracker({
      hasGridChanged: true,
      grid: [[{ text: "hello" }]],
    });

    handler.start("sess-1", tracker as any);
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);

    handler.stop("sess-1");
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS * 10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("handles multiple sessions independently", () => {
    const grid1: TermLine[] = [[{ text: "session 1" }]];
    const grid2: TermLine[] = [[{ text: "session 2" }]];
    const tracker1 = createMockTracker({ hasGridChanged: true, grid: grid1 });
    const tracker2 = createMockTracker({ hasGridChanged: true, grid: grid2 });

    handler.start("sess-1", tracker1 as any);
    handler.start("sess-2", tracker2 as any);

    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);

    const e1 = JSON.parse(send.mock.calls[0][0]);
    const e2 = JSON.parse(send.mock.calls[1][0]);
    expect(e1.sessionId).toBe("sess-1");
    expect(e2.sessionId).toBe("sess-2");
  });

  it("detects new lines added as delta changes", () => {
    const grid1: TermLine[] = [
      [{ text: "line 1" }],
    ];
    const grid2: TermLine[] = [
      [{ text: "line 1" }],
      [{ text: "new line 2" }],
    ];

    const tracker = createMockTracker({ hasGridChanged: true, grid: grid1 });
    handler.start("sess-1", tracker as any);

    // First tick: full
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    tracker.extractGrid.mockReturnValue(grid2);

    // Second tick: delta with new line
    vi.advanceTimersByTime(FRAME_PUSH_INTERVAL_MS);
    const deltaEnvelope = JSON.parse(send.mock.calls[1][0]);
    expect(deltaEnvelope.payload.mode).toBe("delta");
    expect(deltaEnvelope.payload.lines).toEqual([
      { lineIndex: 1, spans: [{ text: "new line 2" }] },
    ]);
  });

  it("FRAME_PUSH_INTERVAL_MS is 200 (5fps)", () => {
    expect(FRAME_PUSH_INTERVAL_MS).toBe(200);
  });
});
