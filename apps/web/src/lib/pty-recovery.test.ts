import { describe, expect, it, vi } from "vitest";
import { createPtyRecoveryController, type PtyRenderTarget } from "./pty-recovery";

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

describe("PtyRecoveryController", () => {
  it("does not accept a snapshot requested by another controller", () => {
    const firstRecovery = createPtyRecoveryController();
    const secondRecovery = createPtyRecoveryController();
    const target = createTarget();

    const firstRequestId = firstRecovery.startSnapshotRequest();
    const secondRequestId = secondRecovery.startSnapshotRequest();

    expect(firstRequestId).not.toBe(secondRequestId);
    expect(
      secondRecovery.applySnapshot(
        {
          requestId: firstRequestId,
          cols: 80,
          rows: 24,
          data: "other client snapshot",
          outputSeq: 1,
        },
        target,
      ),
    ).toEqual({ applied: false, reason: "stale_snapshot" });
    expect(target.calls).toEqual([]);

    expect(
      secondRecovery.applySnapshot(
        {
          requestId: secondRequestId,
          cols: 80,
          rows: 24,
          data: "own snapshot",
          outputSeq: 2,
        },
        target,
      ),
    ).toEqual({ applied: true, replayedEvents: 0 });
    expect(target.calls.at(-1)).toEqual(["write", "own snapshot"]);
  });

  it("buffers binary frames until the matching snapshot is applied", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    const requestId = recovery.startSnapshotRequest();
    const frame = { data: new Uint8Array([65]), outputSeq: 11 };
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: false, hasGap: false });

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["write", frame.data],
    ]);
  });

  it("drops buffered frames already included by the matching snapshot watermark", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    const requestId = recovery.startSnapshotRequest();
    recovery.handleBinaryFrame({ data: new Uint8Array([65]), outputSeq: 10 }, target);

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 0 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
    ]);
  });

  it("reuses an already synchronized target when a reconnect snapshot is unchanged", () => {
    let requestSequence = 0;
    const recovery = createPtyRecoveryController({
      requestIdFactory: () => `req-${++requestSequence}`,
    });
    const target = createTarget();

    const initialRequest = recovery.startSnapshotRequest();
    recovery.applySnapshot(
      { requestId: initialRequest, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );
    target.calls.length = 0;
    const onReplaySettled = vi.fn();

    const reconnectRequest = recovery.startSnapshotRequest({
      preserveTargetIfUnchanged: true,
    });
    const result = recovery.applySnapshot(
      {
        requestId: reconnectRequest,
        cols: 80,
        rows: 24,
        data: "same authoritative snapshot",
        outputSeq: 10,
      },
      target,
      onReplaySettled,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 0 });
    expect(target.calls).toEqual([]);
    expect(onReplaySettled).toHaveBeenCalledWith(false);
  });

  it("reapplies a reconnect snapshot when output or terminal dimensions changed", () => {
    let requestSequence = 0;
    const recovery = createPtyRecoveryController({
      requestIdFactory: () => `req-${++requestSequence}`,
    });
    const target = createTarget();

    const initialRequest = recovery.startSnapshotRequest();
    recovery.applySnapshot(
      { requestId: initialRequest, cols: 80, rows: 24, data: "initial", outputSeq: 10 },
      target,
    );
    target.calls.length = 0;

    const outputChangedRequest = recovery.startSnapshotRequest({
      preserveTargetIfUnchanged: true,
    });
    recovery.applySnapshot(
      {
        requestId: outputChangedRequest,
        cols: 80,
        rows: 24,
        data: "output changed",
        outputSeq: 11,
      },
      target,
    );
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "output changed"],
    ]);

    target.calls.length = 0;
    const dimensionsChangedRequest = recovery.startSnapshotRequest({
      preserveTargetIfUnchanged: true,
    });
    recovery.applySnapshot(
      {
        requestId: dimensionsChangedRequest,
        cols: 100,
        rows: 30,
        data: "dimensions changed",
        outputSeq: 11,
      },
      target,
    );
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "dimensions changed"],
    ]);
  });

  it("reapplies an otherwise unchanged snapshot when the local target geometry changed", () => {
    let requestSequence = 0;
    const recovery = createPtyRecoveryController({
      requestIdFactory: () => `req-${++requestSequence}`,
    });
    const target = createTarget();

    const initialRequest = recovery.startSnapshotRequest();
    recovery.applySnapshot(
      { requestId: initialRequest, cols: 80, rows: 24, data: "initial", outputSeq: 10 },
      target,
    );
    target.resize(100, 30);
    target.calls.length = 0;

    const reconnectRequest = recovery.startSnapshotRequest({
      preserveTargetIfUnchanged: true,
    });
    recovery.applySnapshot(
      {
        requestId: reconnectRequest,
        cols: 80,
        rows: 24,
        data: "authoritative",
        outputSeq: 10,
      },
      target,
    );

    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "authoritative"],
    ]);
  });

  it("waits for old terminal writes and buffers new frames before resetting a reused target", () => {
    const requestIds = ["req-initial", "req-reconnect"];
    const recovery = createPtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      { requestId: "req-initial", cols: 80, rows: 24, data: "initial", outputSeq: 10 },
      target,
    );

    const barrier = { release: null as (() => void) | null };
    target.barrier = (callback) => {
      target.calls.push(["barrier", null]);
      barrier.release = callback;
    };
    target.calls.length = 0;
    recovery.startSnapshotRequest();
    const result = recovery.applySnapshot(
      { requestId: "req-reconnect", cols: 80, rows: 24, data: "fresh", outputSeq: 11 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 0 });
    expect(recovery.hasAppliedSnapshot()).toBe(false);
    expect(target.calls).toEqual([["barrier", null]]);

    const laterFrame = { data: new Uint8Array([0x42]), outputSeq: 12 };
    expect(recovery.handleBinaryFrame(laterFrame, target)).toEqual({
      written: false,
      hasGap: false,
    });
    const releaseBarrier = barrier.release;
    if (!releaseBarrier) throw new Error("target barrier was not armed");
    releaseBarrier();

    expect(recovery.hasAppliedSnapshot()).toBe(true);
    expect(target.calls).toEqual([
      ["barrier", null],
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "fresh"],
      ["write", laterFrame.data],
    ]);
  });

  it("writes binary frames directly after a snapshot is applied", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      {
        requestId: "req-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      },
      target,
    );

    const frame = { data: new Uint8Array([66]), outputSeq: 11 };
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: true, hasGap: false });
    expect(target.calls.at(-1)).toEqual(["write", frame.data]);
  });

  it("buffers out-of-order binary frames and flushes them by outputSeq", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      {
        requestId: "req-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      },
      target,
    );

    const frame12 = { data: new Uint8Array([12]), outputSeq: 12 };
    const frame11 = { data: new Uint8Array([11]), outputSeq: 11 };
    // 12 先到：pendingFrames 有内容但 nextSeq=11 没到 → hasGap
    expect(recovery.handleBinaryFrame(frame12, target)).toEqual({ written: false, hasGap: true });
    // 11 补上：flush 12+13 之类，pendingFrames 清空 → hasGap=false
    expect(recovery.handleBinaryFrame(frame11, target)).toEqual({ written: true, hasGap: false });

    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("flushes a full out-of-order tail before enforcing the pending-event cap", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      { requestId: "req-1", cols: 80, rows: 24, data: "snapshot", outputSeq: 0 },
      target,
    );
    target.calls.length = 0;

    // Fill the 1000-event out-of-order allowance, then deliver the one missing predecessor. The
    // predecessor makes the whole tail contiguous, so none of it should be evicted first.
    for (let outputSeq = 2; outputSeq <= 1001; outputSeq += 1) {
      recovery.handleBinaryFrame({ data: new Uint8Array([outputSeq & 0xff]), outputSeq }, target);
    }
    expect(recovery.handleBinaryFrame({ data: new Uint8Array([1]), outputSeq: 1 }, target)).toEqual(
      { written: true, hasGap: false },
    );

    const writes = target.calls.filter(([operation]) => operation === "write");
    expect(writes).toHaveLength(1001);
    expect(writes[0]).toEqual(["write", new Uint8Array([1])]);
    expect(writes.at(-1)).toEqual(["write", new Uint8Array([1001 & 0xff])]);
  });

  it("orders resize and output events by their shared outputSeq", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      {
        requestId: "req-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      },
      target,
    );
    target.calls.length = 0;

    // Relay control and binary WebSocket delivery can cross in flight. Sequence, not arrival order,
    // determines the exact render order.
    expect(recovery.handleResize({ cols: 100, rows: 30, outputSeq: 12 }, target)).toEqual({
      written: false,
      hasGap: true,
    });
    const beforeResize = new Uint8Array([11]);
    expect(recovery.handleBinaryFrame({ data: beforeResize, outputSeq: 11 }, target)).toEqual({
      written: true,
      hasGap: false,
    });

    expect(target.calls).toEqual([
      ["write", beforeResize],
      ["resize", { cols: 100, rows: 30 }],
    ]);
  });

  it("replays resize and output events after a snapshot in sequence order", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();
    const requestId = recovery.startSnapshotRequest();
    const afterResize = new Uint8Array([12]);

    recovery.handleBinaryFrame({ data: afterResize, outputSeq: 12 }, target);
    recovery.handleResize({ cols: 100, rows: 30, outputSeq: 11 }, target);
    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 2 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["resize", { cols: 100, rows: 30 }],
      ["write", afterResize],
    ]);
  });

  it("drops a buffered resize already covered by the snapshot watermark", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();
    const requestId = recovery.startSnapshotRequest();

    recovery.handleResize({ cols: 100, rows: 30, outputSeq: 10 }, target);
    const result = recovery.applySnapshot(
      { requestId, cols: 100, rows: 30, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 0 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "snapshot"],
    ]);
  });

  it("replays buffered pre-snapshot frames in outputSeq order", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    const requestId = recovery.startSnapshotRequest();
    const frame12 = { data: new Uint8Array([12]), outputSeq: 12 };
    const frame11 = { data: new Uint8Array([11]), outputSeq: 11 };
    recovery.handleBinaryFrame(frame12, target);
    recovery.handleBinaryFrame(frame11, target);

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedEvents: 2 });
    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("keeps later frames buffered until the missing outputSeq arrives", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      {
        requestId: "req-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      },
      target,
    );

    const frame12 = { data: new Uint8Array([12]), outputSeq: 12 };
    expect(recovery.handleBinaryFrame(frame12, target)).toEqual({ written: false, hasGap: true });
    expect(target.calls.at(-1)).toEqual(["write", "snapshot"]);

    const frame11 = { data: new Uint8Array([11]), outputSeq: 11 };
    expect(recovery.handleBinaryFrame(frame11, target)).toEqual({ written: true, hasGap: false });
    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("keeps reporting a pending gap when a stale or duplicate frame arrives", () => {
    const recovery = createPtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot(
      {
        requestId: "req-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 10,
      },
      target,
    );

    expect(
      recovery.handleBinaryFrame({ data: new Uint8Array([12]), outputSeq: 12 }, target),
    ).toEqual({ written: false, hasGap: true });
    expect(
      recovery.handleBinaryFrame({ data: new Uint8Array([10]), outputSeq: 10 }, target),
    ).toEqual({ written: false, hasGap: true });
  });

  it("ignores stale snapshots from older recovery requests", () => {
    const requestIds = ["req-old", "req-new"];
    const recovery = createPtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
    const target = createTarget();

    recovery.startSnapshotRequest();
    const latestRequestId = recovery.startSnapshotRequest();

    expect(
      recovery.applySnapshot(
        { requestId: "req-old", cols: 80, rows: 24, data: "old", outputSeq: 1 },
        target,
      ),
    ).toEqual({ applied: false, reason: "stale_snapshot" });
    expect(target.calls).toEqual([]);

    expect(
      recovery.applySnapshot(
        { requestId: latestRequestId, cols: 100, rows: 30, data: "new", outputSeq: 2 },
        target,
      ),
    ).toEqual({ applied: true, replayedEvents: 0 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "new"],
    ]);
  });

  it("does not flush stale replay frames when a new snapshot request supersedes the in-flight write", () => {
    // 复现 race: applySnapshot 把 replay frames 排进 target.write 的异步 callback;
    // callback 触发前 startSnapshotRequest 又被调用（例如连接恢复），旧 replay 不应再写到 target。
    const requestIds = ["req-1", "req-2"];
    const recovery = createPtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });

    const calls: Array<[string, unknown]> = [];
    const pendingWriteCallback: { fn: (() => void) | null } = { fn: null };
    const target: PtyRenderTarget = {
      reset: vi.fn(() => calls.push(["reset", null])),
      resize: vi.fn((cols: number, rows: number) => calls.push(["resize", { cols, rows }])),
      write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
        calls.push(["write", data]);
        if (callback) {
          // 模拟 xterm 异步写入: 不立即触发 callback, 留给测试控制时机
          pendingWriteCallback.fn = callback;
        }
      }),
    };

    const first = recovery.startSnapshotRequest();
    const staleFrame = { data: new Uint8Array([0xaa]), outputSeq: 11 };
    recovery.handleBinaryFrame(staleFrame, target);

    recovery.applySnapshot(
      { requestId: first, cols: 80, rows: 24, data: "old-snapshot", outputSeq: 10 },
      target,
    );

    // callback 还没 fire，此时连接恢复又发起一轮 snapshot request
    recovery.startSnapshotRequest();

    // 现在旧 callback 异步触发——它持有的 replayFrames 是属于 req-1 周期的
    expect(pendingWriteCallback.fn).toBeTruthy();
    pendingWriteCallback.fn?.();

    // 旧 replay frame 不应再写到 target——req-2 在等新 snapshot, 此时把旧帧写出来会污染。
    const writes = calls.filter(([op]) => op === "write").map(([, data]) => data);
    expect(writes).not.toContainEqual(staleFrame.data);
  });

  it("starts a new buffer window for each snapshot request", () => {
    const requestIds = ["req-1", "req-2"];
    const recovery = createPtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
    const target = createTarget();

    const first = recovery.startSnapshotRequest();
    const staleFrame = { data: new Uint8Array([1]), outputSeq: 1 };
    recovery.handleBinaryFrame(staleFrame, target);

    const second = recovery.startSnapshotRequest();
    const currentFrame = { data: new Uint8Array([2]), outputSeq: 3 };
    recovery.handleBinaryFrame(currentFrame, target);

    expect(
      recovery.applySnapshot(
        { requestId: first, cols: 80, rows: 24, data: "old", outputSeq: 1 },
        target,
      ),
    ).toEqual({ applied: false, reason: "stale_snapshot" });
    expect(
      recovery.applySnapshot(
        { requestId: second, cols: 80, rows: 24, data: "new", outputSeq: 2 },
        target,
      ),
    ).toEqual({ applied: true, replayedEvents: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "new"],
      ["write", currentFrame.data],
    ]);
  });
});
