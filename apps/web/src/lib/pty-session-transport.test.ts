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
      outputSeq: 1,
    });
    harness.emitRelay({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: freshRequestId,
      cols: 100,
      rows: 30,
      data: "new",
      outputSeq: 2,
    });

    expect(target.calls).toEqual([
      ["resize", { cols: 100, rows: 30 }],
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "new"],
    ]);
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
    expect(onSubscribeDelayed).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(harness.sent).toHaveLength(3);
    expect(onSubscribeDelayed).toHaveBeenCalledTimes(1);
  });

  // proxy → relay 闪断时 sendBinary 直接丢帧，但 outputSeq 在 hosted-pty-registry
  // 内仍递增。relay 重连后下一帧带跳过的 seq 到达 web。recovery.flushContiguousFrames
  // 严格按 appliedOutputSeq+1 推进，永远等不到丢失帧 → 屏幕卡住。transport 必须探测
  // 这个 gap 并主动重订 snapshot 让流恢复，否则用户必须手动 resize / reload 才能继续。
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
