import { describe, expect, it, vi } from "vitest";
import { PtyRecoveryController, type PtyRenderTarget } from "./pty-recovery";

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

describe("PtyRecoveryController", () => {
  it("buffers binary frames until the matching snapshot is applied", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    const requestId = recovery.startSnapshotRequest();
    const frame = { data: new Uint8Array([65]), outputSeq: 11 };
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: false });

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedFrames: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["write", frame.data],
    ]);
  });

  it("drops buffered frames already included by the matching snapshot watermark", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    const requestId = recovery.startSnapshotRequest();
    recovery.handleBinaryFrame({ data: new Uint8Array([65]), outputSeq: 10 }, target);

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot", outputSeq: 10 },
      target,
    );

    expect(result).toEqual({ applied: true, replayedFrames: 0 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
    ]);
  });

  it("writes binary frames directly after a snapshot is applied", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
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
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: true });
    expect(target.calls.at(-1)).toEqual(["write", frame.data]);
  });

  it("buffers out-of-order binary frames and flushes them by outputSeq", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
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
    expect(recovery.handleBinaryFrame(frame12, target)).toEqual({ written: false });
    expect(recovery.handleBinaryFrame(frame11, target)).toEqual({ written: true });

    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("replays buffered pre-snapshot frames in outputSeq order", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
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

    expect(result).toEqual({ applied: true, replayedFrames: 2 });
    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("keeps later frames buffered until the missing outputSeq arrives", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
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
    expect(recovery.handleBinaryFrame(frame12, target)).toEqual({ written: false });
    expect(target.calls.at(-1)).toEqual(["write", "snapshot"]);

    const frame11 = { data: new Uint8Array([11]), outputSeq: 11 };
    expect(recovery.handleBinaryFrame(frame11, target)).toEqual({ written: true });
    expect(target.calls.slice(-2)).toEqual([
      ["write", frame11.data],
      ["write", frame12.data],
    ]);
  });

  it("ignores stale snapshots from older resize or reconnect requests", () => {
    const requestIds = ["req-old", "req-new"];
    const recovery = new PtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
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
    ).toEqual({ applied: true, replayedFrames: 0 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 100, rows: 30 }],
      ["write", "new"],
    ]);
  });

  it("starts a new buffer window for each snapshot request", () => {
    const requestIds = ["req-1", "req-2"];
    const recovery = new PtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
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
    ).toEqual({ applied: true, replayedFrames: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "new"],
      ["write", currentFrame.data],
    ]);
  });
});
