import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPtySessionTransport } from "./pty-session-transport";
import type { PtyRenderTarget } from "./pty-recovery";

function createTarget(): PtyRenderTarget & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    reset: vi.fn(() => calls.push(["reset", null])),
    resize: vi.fn((cols: number, rows: number) => calls.push(["resize", { cols, rows }])),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      calls.push(["write", data]);
      callback?.();
    }),
  };
}

function createHarness() {
  let binaryHandler: ((data: Uint8Array) => void) | null = null;
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
      subscribeBinary: vi.fn((_sessionId: string, handler: (data: Uint8Array) => void) => {
        binaryHandler = handler;
        return unsubBinary;
      }),
    },
    relay: {
      onMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
        relayHandler = handler;
        return unsubRelay;
      }),
    },
    emitBinary: (data: Uint8Array) => binaryHandler?.(data),
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests snapshot, buffers binary frames, applies snapshot, and reports ready", () => {
    const harness = createHarness();
    const target = createTarget();
    const onFrameWritten = vi.fn();
    const onReady = vi.fn();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
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
    });

    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["write", frame],
    ]);
    expect(onFrameWritten).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("restarts snapshot window on terminal resize and ignores stale snapshots", () => {
    const harness = createHarness();
    const target = createTarget();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      scheduleReady: (cb) => cb(),
    });
    const staleRequestId = lastRequestId(harness.sent);

    harness.emitRelay({ type: "terminal_resize", sessionId: "s1", cols: 100, rows: 30 });
    const freshRequestId = lastRequestId(harness.sent);
    expect(freshRequestId).not.toBe(staleRequestId);

    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: staleRequestId,
      cols: 80,
      rows: 24,
      data: "old",
    });
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: freshRequestId,
      cols: 100,
      rows: 30,
      data: "new",
    });

    expect(target.calls).toEqual([
      ["resize", { cols: 100, rows: 30 }],
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "new"],
    ]);
  });

  it("retries snapshot requests and reports exhaustion", () => {
    const harness = createHarness();
    const target = createTarget();
    const onSubscribeExhausted = vi.fn();
    attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      retryDelayMs: 10,
      maxRetries: 1,
      onSubscribeExhausted,
    });

    expect(harness.sent).toHaveLength(1);
    vi.advanceTimersByTime(10);
    expect(harness.sent).toHaveLength(2);
    vi.advanceTimersByTime(10);
    expect(onSubscribeExhausted).toHaveBeenCalledTimes(1);
  });

  it("cleans up subscriptions and pending retry timer", () => {
    const harness = createHarness();
    const target = createTarget();
    const onSubscribeExhausted = vi.fn();
    const transport = attachPtySessionTransport({
      sessionId: "s1",
      ws: harness.ws,
      relay: harness.relay,
      target,
      retryDelayMs: 10,
      maxRetries: 0,
      onSubscribeExhausted,
    });

    transport.dispose();
    vi.advanceTimersByTime(10);

    expect(harness.unsubBinary).toHaveBeenCalledTimes(1);
    expect(harness.unsubRelay).toHaveBeenCalledTimes(1);
    expect(onSubscribeExhausted).not.toHaveBeenCalled();
  });
});
