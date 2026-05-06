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
    const frame = new Uint8Array([65]);
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: false });

    const result = recovery.applySnapshot(
      { requestId, cols: 80, rows: 24, data: "snapshot" },
      target,
    );

    expect(result).toEqual({ applied: true, replayedFrames: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "snapshot"],
      ["write", frame],
    ]);
  });

  it("writes binary frames directly after a snapshot is applied", () => {
    const recovery = new PtyRecoveryController({ requestIdFactory: () => "req-1" });
    const target = createTarget();

    recovery.startSnapshotRequest();
    recovery.applySnapshot({ requestId: "req-1", cols: 80, rows: 24, data: "snapshot" }, target);

    const frame = new Uint8Array([66]);
    expect(recovery.handleBinaryFrame(frame, target)).toEqual({ written: true });
    expect(target.calls.at(-1)).toEqual(["write", frame]);
  });

  it("ignores stale snapshots from older resize or reconnect requests", () => {
    const requestIds = ["req-old", "req-new"];
    const recovery = new PtyRecoveryController({ requestIdFactory: () => requestIds.shift()! });
    const target = createTarget();

    recovery.startSnapshotRequest();
    const latestRequestId = recovery.startSnapshotRequest();

    expect(
      recovery.applySnapshot({ requestId: "req-old", cols: 80, rows: 24, data: "old" }, target),
    ).toEqual({ applied: false, reason: "stale_snapshot" });
    expect(target.calls).toEqual([]);

    expect(
      recovery.applySnapshot(
        { requestId: latestRequestId, cols: 100, rows: 30, data: "new" },
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
    const staleFrame = new Uint8Array([1]);
    recovery.handleBinaryFrame(staleFrame, target);

    const second = recovery.startSnapshotRequest();
    const currentFrame = new Uint8Array([2]);
    recovery.handleBinaryFrame(currentFrame, target);

    expect(
      recovery.applySnapshot({ requestId: first, cols: 80, rows: 24, data: "old" }, target),
    ).toEqual({ applied: false, reason: "stale_snapshot" });
    expect(
      recovery.applySnapshot({ requestId: second, cols: 80, rows: 24, data: "new" }, target),
    ).toEqual({ applied: true, replayedFrames: 1 });
    expect(target.calls).toEqual([
      ["reset", null],
      ["resize", { cols: 80, rows: 24 }],
      ["write", "new"],
      ["write", currentFrame],
    ]);
  });
});
