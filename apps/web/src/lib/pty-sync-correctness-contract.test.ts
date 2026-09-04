import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPtyRecoveryController, type PtyRenderTarget } from "./pty-recovery";
import { attachPtySessionTransport } from "./pty-session-transport";

type TargetCall = [operation: "reset" | "resize" | "write", value: unknown];

function createImmediateTarget(): PtyRenderTarget & { calls: TargetCall[] } {
  const calls: TargetCall[] = [];
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
  calls: TargetCall[];
  pendingWriteCallbacks: Array<() => void>;
} {
  const calls: TargetCall[] = [];
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

function createTransportHarness() {
  let binaryHandler: ((data: Uint8Array, outputSeq: number) => void) | null = null;
  let relayHandler: ((message: Record<string, unknown>) => void) | null = null;
  const sent: string[] = [];

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
          return vi.fn();
        },
      ),
    },
    relay: {
      onMessage: vi.fn((handler: (message: Record<string, unknown>) => void) => {
        relayHandler = handler;
        return vi.fn();
      }),
    },
    emitBinary: (data: Uint8Array, outputSeq: number) => binaryHandler?.(data, outputSeq),
    emitRelay: (message: Record<string, unknown>) => relayHandler?.(message),
  };
}

function requestIdAt(sent: string[], index: number): string {
  const message = JSON.parse(sent[index] ?? "{}") as { requestId?: string };
  if (!message.requestId) throw new Error(`missing requestId at sent[${index}]`);
  return message.requestId;
}

function snapshotMessage(requestId: string, outputSeq: number, data = "snapshot") {
  return {
    type: "session_snapshot",
    sessionId: "s1",
    requestId,
    cols: 80,
    rows: 24,
    data,
    outputSeq,
  };
}

function binaryWriteValues(calls: TargetCall[]): number[] {
  return calls.flatMap(([operation, value]) =>
    operation === "write" && value instanceof Uint8Array ? Array.from(value) : [],
  );
}

describe("PTY synchronization correctness contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.removeItem("dev_anywhere_pty_input_latency_trace");
    window.__devAnywherePtyInputLatencyTrace = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays only the contiguous S+1 tail once when frames arrive during snapshot parsing", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "request-1" });
    const target = createControlledTarget();
    const requestId = recovery.startSnapshotRequest();

    // seq=12 arrives before the authoritative snapshot. Parsing the snapshot then stays pending
    // while 13, 11, and a duplicated 12 arrive. The final terminal stream must still be 11,12,13.
    recovery.handleBinaryFrame({ data: new Uint8Array([12]), outputSeq: 12 }, target);
    expect(
      recovery.applySnapshot(
        { requestId, cols: 80, rows: 24, data: "snapshot-S10", outputSeq: 10 },
        target,
      ),
    ).toEqual({ applied: true, replayedEvents: 1 });
    recovery.handleBinaryFrame({ data: new Uint8Array([13]), outputSeq: 13 }, target);
    recovery.handleBinaryFrame({ data: new Uint8Array([11]), outputSeq: 11 }, target);
    recovery.handleBinaryFrame({ data: new Uint8Array([12]), outputSeq: 12 }, target);

    expect(binaryWriteValues(target.calls)).toEqual([]);
    expect(target.pendingWriteCallbacks).toHaveLength(1);
    target.pendingWriteCallbacks.shift()?.();

    expect(binaryWriteValues(target.calls)).toEqual([11, 12, 13]);
    expect(recovery.hasPendingGap()).toBe(false);

    // A network duplicate after the replay watermark must not be rendered a second time.
    recovery.handleBinaryFrame({ data: new Uint8Array([12]), outputSeq: 12 }, target);
    expect(binaryWriteValues(target.calls)).toEqual([11, 12, 13]);
  });

  it("does not announce ready until replay writes settle and a paint boundary runs", () => {
    const harness = createTransportHarness();
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
    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));

    // The snapshot has been submitted to xterm, but its parser callback has not fired.
    expect(onReady).not.toHaveBeenCalled();
    expect(paintBoundaries).toHaveLength(0);
    target.pendingWriteCallbacks.shift()?.();

    // Snapshot parsing may enqueue the replay RAF, but it is not a ready terminal yet.
    expect(frameFlushes).toHaveLength(1);
    expect(paintBoundaries).toHaveLength(0);
    frameFlushes.shift()?.(16);

    // The replay bytes have only been submitted to xterm. Wait for its write callback as well.
    expect(binaryWriteValues(target.calls)).toEqual([11]);
    expect(paintBoundaries).toHaveLength(0);
    target.pendingWriteCallbacks.shift()?.();

    // The parser is settled; the injected boundary represents the browser's next paint turn.
    expect(onReady).not.toHaveBeenCalled();
    expect(paintBoundaries).toHaveLength(1);
    paintBoundaries.shift()?.();
    expect(onReady).toHaveBeenCalledTimes(1);

    transport.dispose();
  });

  it("keeps resize between the exact writes even while xterm is still parsing", () => {
    const harness = createTransportHarness();
    const target = createControlledTarget();
    const frameFlushes: FrameRequestCallback[] = [];
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
      scheduleReady: (callback) => callback(),
    });

    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));
    target.pendingWriteCallbacks.shift()?.();
    target.calls.length = 0;

    const beforeResize = new Uint8Array([11]);
    const afterResize = new Uint8Array([13]);
    harness.emitBinary(beforeResize, 11);
    frameFlushes.shift()?.(16);
    expect(target.calls).toEqual([["write", beforeResize]]);

    // Both later events arrive while xterm has not acknowledged parsing seq=11.
    harness.emitRelay({
      type: "terminal_resize",
      sessionId: "s1",
      cols: 100,
      rows: 30,
      outputSeq: 12,
    });
    harness.emitBinary(afterResize, 13);
    expect(target.calls).toEqual([["write", beforeResize]]);
    expect(frameFlushes).toHaveLength(0);

    target.pendingWriteCallbacks.shift()?.();
    expect(target.calls).toEqual([
      ["write", beforeResize],
      ["resize", { cols: 100, rows: 30 }],
    ]);
    expect(frameFlushes).toHaveLength(1);

    frameFlushes.shift()?.(32);
    expect(target.calls).toEqual([
      ["write", beforeResize],
      ["resize", { cols: 100, rows: 30 }],
      ["write", afterResize],
    ]);

    transport.dispose();
  });

  it("waits for an in-flight live write before reusing an unchanged resume snapshot", () => {
    const harness = createTransportHarness();
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

    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));
    target.pendingWriteCallbacks.shift()?.();
    paintBoundaries.shift()?.();
    expect(onReady).toHaveBeenCalledTimes(1);

    const inFlight = new Uint8Array([11]);
    harness.emitBinary(inFlight, 11);
    frameFlushes.shift()?.(16);
    expect(target.calls.at(-1)).toEqual(["write", inFlight]);

    transport.pause();
    transport.resume();
    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 1), 11, "unchanged"));

    // Recovery can reuse the existing xterm, but readiness still fences the parser work which was
    // already submitted before pause.
    expect(paintBoundaries).toHaveLength(0);
    expect(onReady).toHaveBeenCalledTimes(1);
    target.pendingWriteCallbacks.shift()?.();
    expect(paintBoundaries).toHaveLength(1);
    expect(onReady).toHaveBeenCalledTimes(1);

    paintBoundaries.shift()?.();
    expect(onReady).toHaveBeenCalledTimes(2);
    transport.dispose();
  });

  it("waits for an active old write before resetting to a gap-recovery snapshot", () => {
    const harness = createTransportHarness();
    const target = createControlledTarget();
    const frameFlushes: FrameRequestCallback[] = [];
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      gapRecoveryDelayMs: 2_000,
      scheduleFrameFlush: (callback) => {
        frameFlushes.push(callback);
        return frameFlushes.length;
      },
      cancelFrameFlush: vi.fn(),
      scheduleReady: (callback) => callback(),
    });

    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));
    target.pendingWriteCallbacks.shift()?.();
    target.calls.length = 0;

    const oldWrite = new Uint8Array([11]);
    harness.emitBinary(oldWrite, 11);
    frameFlushes.shift()?.(16);
    harness.emitBinary(new Uint8Array([13]), 13);
    vi.advanceTimersByTime(2_000);
    expect(harness.sent).toHaveLength(2);

    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 1), 13, "authoritative-S13"));
    expect(target.calls).toEqual([["write", oldWrite]]);

    // The old parser callback releases a real xterm barrier; reset still cannot cross it.
    target.pendingWriteCallbacks.shift()?.();
    expect(target.calls).toEqual([
      ["write", oldWrite],
      ["write", ""],
    ]);
    target.pendingWriteCallbacks.shift()?.();
    expect(target.calls).toEqual([
      ["write", oldWrite],
      ["write", ""],
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "authoritative-S13"],
    ]);

    const binaryWrites = target.calls.filter(
      ([operation, value]) => operation === "write" && value instanceof Uint8Array,
    );
    expect(binaryWrites).toEqual([["write", oldWrite]]);
    transport.dispose();
  });

  it("keeps a delayed snapshot valid when a retry was sent while it was in flight", () => {
    const harness = createTransportHarness();
    const target = createImmediateTarget();
    const onReady = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      retryDelayMs: 100,
      slowNoticeDelayMs: 10_000,
      scheduleReady: (callback) => callback(),
      onReady,
    });
    const firstRequestId = requestIdAt(harness.sent, 0);

    vi.advanceTimersByTime(100);
    expect(harness.sent).toHaveLength(2);

    // This response belongs to the first attempt, but is still authoritative. A retry must not
    // invalidate useful work already traversing a slow link and create a retry-starvation loop.
    harness.emitBinary(new Uint8Array([11]), 11);
    harness.emitRelay(snapshotMessage(firstRequestId, 10, "delayed-authoritative-snapshot"));
    vi.advanceTimersByTime(16);

    expect(target.calls).toContainEqual(["write", "delayed-authoritative-snapshot"]);
    expect(binaryWriteValues(target.calls)).toEqual([11]);
    expect(onReady).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(harness.sent).toHaveLength(2);
    transport.dispose();
  });

  it("does not cancel persistent-gap recovery when a duplicate old frame arrives", () => {
    const harness = createTransportHarness();
    const target = createImmediateTarget();
    const onGapRecovery = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      gapRecoveryDelayMs: 2_000,
      scheduleReady: (callback) => callback(),
      onGapRecovery,
    });
    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));

    harness.emitBinary(new Uint8Array([12]), 12);
    vi.advanceTimersByTime(1_000);
    // seq=10 is already covered by the snapshot. It changes nothing about the missing seq=11.
    harness.emitBinary(new Uint8Array([10]), 10);
    vi.advanceTimersByTime(1_000);

    expect(onGapRecovery).toHaveBeenCalledTimes(1);
    expect(harness.sent).toHaveLength(2);
    transport.dispose();
  });

  it("does not announce ready across a replay gap and becomes ready when the gap closes", () => {
    const harness = createTransportHarness();
    const target = createImmediateTarget();
    const frameFlushes: FrameRequestCallback[] = [];
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
      scheduleReady: (callback) => callback(),
      onReady,
    });

    harness.emitBinary(new Uint8Array([12]), 12);
    harness.emitRelay(snapshotMessage(requestIdAt(harness.sent, 0), 10));
    expect(onReady).not.toHaveBeenCalled();
    expect(binaryWriteValues(target.calls)).toEqual([]);

    harness.emitBinary(new Uint8Array([11]), 11);
    expect(frameFlushes).toHaveLength(1);
    frameFlushes.shift()?.(16);
    expect(binaryWriteValues(target.calls)).toEqual([11, 12]);
    expect(onReady).toHaveBeenCalledTimes(1);

    transport.dispose();
  });

  it("isolates two clients sharing a session from each other's snapshot responses", () => {
    const first = createTransportHarness();
    const second = createTransportHarness();
    const firstTarget = createImmediateTarget();
    const secondTarget = createImmediateTarget();
    const firstTransport = attachPtySessionTransport({
      sessionId: "s1",
      ws: first.ws,
      relay: first.relay,
      target: firstTarget,
      scheduleReady: (callback) => callback(),
    });
    const secondTransport = attachPtySessionTransport({
      sessionId: "s1",
      ws: second.ws,
      relay: second.relay,
      target: secondTarget,
      scheduleReady: (callback) => callback(),
    });
    const firstRequestId = requestIdAt(first.sent, 0);
    const secondRequestId = requestIdAt(second.sent, 0);
    expect(firstRequestId).not.toBe(secondRequestId);

    const broadcast = (message: Record<string, unknown>) => {
      first.emitRelay(message);
      second.emitRelay(message);
    };
    broadcast(snapshotMessage(secondRequestId, 20, "second-client-snapshot"));
    expect(firstTarget.calls).toEqual([]);
    expect(secondTarget.calls).toContainEqual(["write", "second-client-snapshot"]);

    broadcast(snapshotMessage(firstRequestId, 21, "first-client-snapshot"));
    expect(firstTarget.calls).toContainEqual(["write", "first-client-snapshot"]);
    expect(
      secondTarget.calls.filter(
        ([operation, value]) => operation === "write" && typeof value === "string",
      ),
    ).toEqual([["write", "second-client-snapshot"]]);

    firstTransport.dispose();
    secondTransport.dispose();
  });
});
