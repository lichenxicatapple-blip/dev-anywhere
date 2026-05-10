type WriteCallback = () => void;

export interface PtyRenderTarget {
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string | Uint8Array, callback?: WriteCallback) => void;
}

interface PtySnapshotMessage {
  requestId?: string;
  cols: number;
  rows: number;
  data: string;
  outputSeq: number;
}

interface PtyRecoveryOptions {
  requestIdFactory?: () => string;
}

type SnapshotResult =
  | { applied: true; replayedFrames: number }
  | { applied: false; reason: "stale_snapshot" | "no_active_request" };

export interface PtyRecoveryController {
  startSnapshotRequest: () => string;
  hasAppliedSnapshot: () => boolean;
  hasPendingGap: () => boolean;
  handleBinaryFrame: (
    frame: { data: Uint8Array; outputSeq: number },
    target: PtyRenderTarget,
  ) => { written: boolean; hasGap: boolean };
  applySnapshot: (snapshot: PtySnapshotMessage, target: PtyRenderTarget) => SnapshotResult;
}

export function createPtyRecoveryController(
  options: PtyRecoveryOptions = {},
): PtyRecoveryController {
  let seq = 0;
  const requestIdFactory = options.requestIdFactory ?? (() => `pty-snapshot-${++seq}`);

  let activeRequestId: string | null = null;
  let snapshotApplied = false;
  let frameBuffer: Array<{ data: Uint8Array; outputSeq: number }> = [];
  const pendingFrames = new Map<number, Uint8Array>();
  let appliedOutputSeq = 0;

  const flushContiguousFrames = (target: PtyRenderTarget): number => {
    let written = 0;
    let nextSeq = appliedOutputSeq + 1;
    while (pendingFrames.has(nextSeq)) {
      const data = pendingFrames.get(nextSeq)!;
      pendingFrames.delete(nextSeq);
      appliedOutputSeq = nextSeq;
      target.write(data);
      written += 1;
      nextSeq += 1;
    }
    return written;
  };

  return {
    startSnapshotRequest() {
      const requestId = requestIdFactory();
      activeRequestId = requestId;
      snapshotApplied = false;
      frameBuffer = [];
      pendingFrames.clear();
      return requestId;
    },

    hasAppliedSnapshot() {
      return snapshotApplied;
    },

    hasPendingGap() {
      return snapshotApplied && pendingFrames.size > 0;
    },

    handleBinaryFrame(frame, target) {
      if (!snapshotApplied) {
        frameBuffer.push(frame);
        return { written: false, hasGap: false };
      }
      if (frame.outputSeq <= appliedOutputSeq) return { written: false, hasGap: false };
      pendingFrames.set(frame.outputSeq, frame.data);
      const written = flushContiguousFrames(target) > 0;
      // hasGap = flush 之后仍有 pendingFrames 没消费，说明 appliedOutputSeq+1 还没到。
      // proxy↔relay 闪断会让 sendBinary 丢帧但 outputSeq 仍递增，恢复后下一帧 seq 就跳过了
      // 中间若干个值，当前 frame 来填不到 nextSeq，整流就会卡死直到下次 ws 自然重连。
      // 把 gap 信号外抛，由 transport 层做超时恢复（短期 gap 来自乱序，不该误触发）。
      return { written, hasGap: pendingFrames.size > 0 };
    },

    applySnapshot(snapshot, target) {
      if (!activeRequestId) {
        return { applied: false, reason: "no_active_request" };
      }
      if (snapshot.requestId !== activeRequestId) {
        return { applied: false, reason: "stale_snapshot" };
      }

      const frames = frameBuffer;
      frameBuffer = [];
      pendingFrames.clear();
      activeRequestId = null;
      snapshotApplied = true;
      appliedOutputSeq = snapshot.outputSeq;
      const replayFrames = frames
        .filter((frame) => frame.outputSeq > snapshot.outputSeq)
        .sort((a, b) => a.outputSeq - b.outputSeq);

      target.reset();
      target.resize(snapshot.cols, snapshot.rows);
      target.write(snapshot.data, () => {
        for (const frame of replayFrames) {
          pendingFrames.set(frame.outputSeq, frame.data);
        }
        flushContiguousFrames(target);
      });

      return { applied: true, replayedFrames: replayFrames.length };
    },
  };
}
