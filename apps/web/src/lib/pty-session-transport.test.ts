import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtySessionTransport } from "./pty-session-transport";
import type { PtyRenderTarget } from "./pty-recovery";

function createTarget(): PtyRenderTarget & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  let dimensions = { cols: 0, rows: 0 };
  return {
    calls,
    reset: vi.fn(() => calls.push(["reset", null])),
    resize: vi.fn((cols: number, rows: number) => {
      dimensions = { cols, rows };
      calls.push(["resize", { cols, rows }]);
    }),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      calls.push(["write", data]);
      callback?.();
    }),
    getDimensions: () => dimensions,
  };
}

function createControlledTarget(): PtyRenderTarget & {
  calls: Array<[string, unknown]>;
  pendingWriteCallbacks: Array<() => void>;
} {
  const calls: Array<[string, unknown]> = [];
  const pendingWriteCallbacks: Array<() => void> = [];
  let dimensions = { cols: 0, rows: 0 };
  return {
    calls,
    pendingWriteCallbacks,
    reset: vi.fn(() => calls.push(["reset", null])),
    resize: vi.fn((cols: number, rows: number) => {
      dimensions = { cols, rows };
      calls.push(["resize", { cols, rows }]);
    }),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      calls.push(["write", data]);
      if (callback) pendingWriteCallbacks.push(callback);
    }),
    getDimensions: () => dimensions,
  };
}

function createHarness() {
  let binaryHandler: ((data: Uint8Array, outputSeq: number) => void) | null = null;
  let relayHandler: ((msg: Record<string, unknown>) => void) | null = null;
  const sent: string[] = [];
  const unsubBinary = vi.fn();
  const unsubRelay = vi.fn();
  return {
    sent,
    ws: {
      send: vi.fn((data: string) => {
        sent.push(data);
        return true;
      }),
      subscribeBinary: vi.fn(
        (_sessionId: string, handler: (data: Uint8Array, outputSeq: number) => void) => {
          binaryHandler = handler;
          return unsubBinary;
        },
      ),
    },
    relay: {
      onMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
        relayHandler = handler;
        return unsubRelay;
      }),
    },
    emitBinary: (data: Uint8Array, outputSeq = 1) => binaryHandler?.(data, outputSeq),
    emitRelay: (msg: Record<string, unknown>) => relayHandler?.(msg),
    unsubBinary,
    unsubRelay,
  };
}

function lastRequestId(sent: string[]): string {
  const msg = JSON.parse(sent.at(-1) ?? "{}") as { requestId?: string };
  if (!msg.requestId) throw new Error("missing requestId");
  return msg.requestId;
}

describe("attachPtySessionTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.removeItem("dev_anywhere_pty_input_latency_trace");
    window.__devAnywherePtyInputLatencyTrace = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests snapshot, buffers binary frames, applies snapshot, and reports ready", () => {
    const harness = createHarness();
    const target = createTarget();
    const onFramePending = vi.fn();
    const onFrameWritten = vi.fn();
    const onReady = vi.fn();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
      onFramePending,
      onFrameWritten,
      onReady,
    });

    const frame = new Uint8Array([65]);
    harness.emitBinary(frame);
    expect(target.write).not.toHaveBeenCalled();

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 0,
    });

    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
    ]);
    expect(onFramePending).toHaveBeenCalledTimes(1);
    expect(onFrameWritten).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["write", frame],
    ]);
    expect(onFrameWritten).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("records output receive/write/paint when PTY input latency trace is enabled", () => {
    window.localStorage.setItem("dev_anywhere_pty_input_latency_trace", "1");
    const harness = createHarness();
    const target = createTarget();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 0,
    });

    harness.emitBinary(new Uint8Array([65]), 1);
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(16);

    const events = (window.__devAnywherePtyInputLatencyTrace ?? []).map((entry) => entry.event);
    expect(events).toContain("output:received");
    expect(events).toContain("output:xterm-write");
  });

  it("renders an ordered terminal resize without restarting snapshot synchronization", () => {
    const harness = createHarness();
    const target = createTarget();
    const onSubscribeStarted = vi.fn();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
      onSubscribeStarted,
    });
    const requestId = lastRequestId(harness.sent);
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId,
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 10,
    });
    target.calls.length = 0;

    // Resize control can arrive before the binary frame that precedes it. Recovery uses the shared
    // sequence to restore bytes(11) -> resize(12) -> bytes(13).
    harness.emitRelay({
      type: "terminal_resize",
      sessionId: "s1",
      cols: 100,
      rows: 30,
      outputSeq: 12,
    });
    const afterResize = new Uint8Array([13]);
    const beforeResize = new Uint8Array([11]);
    harness.emitBinary(afterResize, 13);
    harness.emitBinary(beforeResize, 11);
    vi.advanceTimersByTime(32);

    expect(target.calls).toEqual([
      ["write", beforeResize],
      ["resize", { cols: 100, rows: 30 }],
      ["write", afterResize],
    ]);
    expect(harness.sent).toHaveLength(1);
    expect(onSubscribeStarted).toHaveBeenCalledTimes(1);
  });

  it("reports slow snapshot sync before retrying at a lower frequency", () => {
    const harness = createHarness();
    const target = createTarget();
    const onSubscribeDelayed = vi.fn();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      onSubscribeDelayed,
    });

    expect(harness.sent).toHaveLength(1);
    const logicalRequestId = lastRequestId(harness.sent);
    vi.advanceTimersByTime(9999);
    expect(harness.sent).toHaveLength(1);
    expect(onSubscribeDelayed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(harness.sent).toHaveLength(1);
    expect(onSubscribeDelayed).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(19_999);
    expect(harness.sent).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(harness.sent).toHaveLength(2);
    expect(lastRequestId(harness.sent)).toBe(logicalRequestId);
    expect(onSubscribeDelayed).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(harness.sent).toHaveLength(3);
    expect(lastRequestId(harness.sent)).toBe(logicalRequestId);
    expect(onSubscribeDelayed).toHaveBeenCalledTimes(1);
  });

  it("keeps an ordered resize out of connection state and invalidates ready on pause and dispose", () => {
    const createPendingReadyTransport = () => {
      const harness = createHarness();
      const target = createTarget();
      const paintBoundaries: Array<() => void> = [];
      const onReady = vi.fn();
      const transport = attachPtySessionTransport({
        sessionId: "s1",
        ws: harness.ws,
        relay: harness.relay,
        target,
        scheduleReady: (callback) => paintBoundaries.push(callback),
        onReady,
      });
      harness.emitRelay({
        type: "session_snapshot",
        sessionId: "s1",
        requestId: lastRequestId(harness.sent),
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      });
      expect(paintBoundaries).toHaveLength(1);
      return { harness, transport, paintBoundaries, onReady };
    };

    const resized = createPendingReadyTransport();
    resized.harness.emitRelay({
      type: "terminal_resize",
      sessionId: "s1",
      cols: 100,
      rows: 30,
      outputSeq: 11,
    });
    resized.paintBoundaries.shift()?.();
    expect(resized.onReady).toHaveBeenCalledTimes(1);
    resized.transport.dispose();

    const paused = createPendingReadyTransport();
    paused.transport.pause();
    paused.paintBoundaries.shift()?.();
    expect(paused.onReady).not.toHaveBeenCalled();
    paused.transport.dispose();

    const disposed = createPendingReadyTransport();
    disposed.transport.dispose();
    disposed.paintBoundaries.shift()?.();
    expect(disposed.onReady).not.toHaveBeenCalled();
  });

  it("does not let future live frames extend the replay readiness fence", () => {
    const harness = createHarness();
    const target = createControlledTarget();
    const frameFlushes: FrameRequestCallback[] = [];
    const paintBoundaries: Array<() => void> = [];
    const onReady = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleFrameFlush: (callback) => {
        frameFlushes.push(callback);
        return frameFlushes.length;
      },
      cancelFrameFlush: vi.fn(),
      scheduleReady: (callback) => paintBoundaries.push(callback),
      onReady,
    });

    harness.emitBinary(new Uint8Array([11]), 11);
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 10,
    });
    target.pendingWriteCallbacks.shift()?.();
    frameFlushes.shift()?.(16);

    // The replay batch is now in xterm. Frames from the still-running PTY arrive afterwards.
    harness.emitBinary(new Uint8Array([12]), 12);
    harness.emitBinary(new Uint8Array([13]), 13);
    expect(frameFlushes).toHaveLength(0);
    target.pendingWriteCallbacks.shift()?.();

    expect(paintBoundaries).toHaveLength(1);
    paintBoundaries.shift()?.();
    expect(onReady).toHaveBeenCalledTimes(1);
    // seq 12/13 now form a later batch, proving they neither crossed nor extended the replay fence.
    expect(frameFlushes).toHaveLength(1);
    transport.dispose();
  });

  it("pauses without disposing and reuses an unchanged synchronized terminal on resume", () => {
    const harness = createHarness();
    const target = createTarget();
    const onReady = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
      onReady,
    });
    const initialRequestId = lastRequestId(harness.sent);

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: initialRequestId,
      cols: 80,
      rows: 24,
      data: "initial snapshot",
      outputSeq: 10,
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    target.calls.length = 0;

    transport.pause();
    harness.emitBinary(new Uint8Array([0x41]), 11);
    expect(target.calls).toEqual([]);

    transport.resume();
    expect(harness.sent).toHaveLength(2);
    expect(lastRequestId(harness.sent)).not.toBe(initialRequestId);
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "same state, serialization need not be parsed",
      outputSeq: 10,
    });

    expect(target.calls).toEqual([]);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(harness.unsubBinary).not.toHaveBeenCalled();
    expect(harness.unsubRelay).not.toHaveBeenCalled();
  });

  it("keeps a received pre-disconnect frame queued when an unchanged reconnect snapshot arrives", () => {
    const harness = createHarness();
    const target = createTarget();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "initial",
      outputSeq: 10,
    });
    target.calls.length = 0;

    const receivedBeforeDisconnect = new Uint8Array([0x41]);
    harness.emitBinary(receivedBeforeDisconnect, 11);
    transport.pause();
    transport.resume();
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "same state",
      outputSeq: 11,
    });

    expect(target.calls).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(target.calls).toEqual([["write", receivedBeforeDisconnect]]);
  });

  it("reapplies the authoritative snapshot after resume when output changed", () => {
    const harness = createHarness();
    const target = createTarget();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "initial",
      outputSeq: 10,
    });
    target.calls.length = 0;

    transport.pause();
    transport.resume();
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: lastRequestId(harness.sent),
      cols: 80,
      rows: 24,
      data: "changed",
      outputSeq: 11,
    });

    expect(target.calls).toEqual([
      ["write", ""],
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "changed"],
    ]);
  });

  // proxy → relay 闪断时 sendBinary 直接丢帧，但 outputSeq 在 hosted-pty-registry
  // 内仍递增。relay 重连后下一帧带跳过的 seq 到达 web。recovery.flushContiguousFrames
  // 严格按 appliedOutputSeq+1 推进，永远等不到丢失帧 → 屏幕卡住。transport 必须探测
  // 这个 gap 并主动重订 snapshot 让流恢复，否则用户必须 reload 才能继续。
  it("re-subscribes snapshot when binary frames have a persistent outputSeq gap", () => {
    const harness = createHarness();
    const target = createTarget();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });
    const initialRequestId = lastRequestId(harness.sent);

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: initialRequestId,
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 10,
    });
    expect(harness.sent).toHaveLength(1);

    // 模拟服务端闪断丢了 seq=11，后续帧从 seq=12 开始；seq=11 永远不会到达
    harness.emitBinary(new Uint8Array([0x41]), 12);
    harness.emitBinary(new Uint8Array([0x42]), 13);
    harness.emitBinary(new Uint8Array([0x43]), 14);

    // RAF 跑过：因为 seq 11 缺失，flushContiguousFrames 卡在 11，没有任何 binary frame 被写入
    vi.advanceTimersByTime(16);
    const binaryWritesBeforeRecovery = target.calls.filter(
      ([type, data]) => type === "write" && data instanceof Uint8Array,
    );
    expect(binaryWritesBeforeRecovery).toEqual([]);

    // gap 持续超过恢复阈值后，transport 应主动重订 snapshot 让流恢复
    vi.advanceTimersByTime(2_000);

    expect(harness.sent.length).toBeGreaterThan(1);
    const recoveryRequestId = lastRequestId(harness.sent);
    expect(recoveryRequestId).not.toBe(initialRequestId);
  });

  it("does not re-subscribe when the missing frame fills the gap before timeout", () => {
    const harness = createHarness();
    const target = createTarget();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });
    const initialRequestId = lastRequestId(harness.sent);

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: initialRequestId,
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 10,
    });

    // 帧乱序到达：12 先到（产生临时 gap），紧接着 11 补齐 — 不该触发恢复重订。
    harness.emitBinary(new Uint8Array([0x42]), 12);
    vi.advanceTimersByTime(100);
    harness.emitBinary(new Uint8Array([0x41]), 11);

    vi.advanceTimersByTime(5_000);
    expect(harness.sent).toHaveLength(1);
  });

  it("recovers a gap created when the pre-snapshot frame buffer reaches its limit", () => {
    const harness = createHarness();
    const target = createTarget();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });
    const requestId = lastRequestId(harness.sent);

    // frameBuffer 最多保留 5000 帧；第 5001 帧会淘汰 seq=1，留下一个永久缺口。
    for (let outputSeq = 1; outputSeq <= 5001; outputSeq += 1) {
      harness.emitBinary(new Uint8Array([outputSeq & 0xff]), outputSeq);
    }
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId,
      cols: 80,
      rows: 24,
      data: "snapshot",
      outputSeq: 0,
    });

    vi.advanceTimersByTime(2_000);
    expect(harness.sent).toHaveLength(2);
  });

  it("cleans up subscriptions and pending retry timer", () => {
    const harness = createHarness();
    const target = createTarget();
    const onSubscribeDelayed = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      retryDelayMs: 10,
      slowNoticeDelayMs: 10,
      onSubscribeDelayed,
    });

    transport.dispose();
    vi.advanceTimersByTime(10);

    expect(harness.unsubBinary).toHaveBeenCalledTimes(1);
    expect(harness.unsubRelay).toHaveBeenCalledTimes(1);
    expect(onSubscribeDelayed).not.toHaveBeenCalled();
  });
});
