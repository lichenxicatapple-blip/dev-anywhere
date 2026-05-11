type WriteCallback = () => void;

// snapshot 等待期间 frameBuffer 上限。proxy↔relay 长时间断连或 snapshot 一直不到时, 这里
// 会无限制堆积。超过时丢最老的, 让用户最终拿到 partial recovery 而不是浏览器 OOM。
const MAX_FRAME_BUFFER = 5000;
// snapshot 已应用后, pendingFrames 缓存乱序帧。outputSeq 跳过的多 (proxy↔relay 闪断丢帧)
// 时, 后续帧持续往里塞, 永远 flush 不出去 (gap 没人补)。超过时丢最老的, 让 transport 层
// 通过 hasGap 信号触发新一轮 snapshot 重新对齐。
const MAX_PENDING_FRAMES = 1000;

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

interface PtyRecoveryController {
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
  // 每次 startSnapshotRequest / applySnapshot 都 ++; applySnapshot 把当前值塞进异步 write
  // callback 闭包, callback 触发时若 generation 已被新 startSnapshotRequest 推进, 说明
  // 期间发生了新一轮 recovery, 旧 replay frames 不能再写到 target——会污染新窗口。
  let snapshotGeneration = 0;

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
      snapshotGeneration += 1;
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
        if (frameBuffer.length > MAX_FRAME_BUFFER) {
          frameBuffer.splice(0, frameBuffer.length - MAX_FRAME_BUFFER);
        }
        return { written: false, hasGap: false };
      }
      if (frame.outputSeq <= appliedOutputSeq) return { written: false, hasGap: false };
      pendingFrames.set(frame.outputSeq, frame.data);
      if (pendingFrames.size > MAX_PENDING_FRAMES) {
        // Map.keys() 按插入顺序, 删最早进的那条
        const oldest = pendingFrames.keys().next().value;
        if (oldest !== undefined) pendingFrames.delete(oldest);
      }
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
      snapshotGeneration += 1;
      const myGeneration = snapshotGeneration;
      const replayFrames = frames
        .filter((frame) => frame.outputSeq > snapshot.outputSeq)
        .sort((a, b) => a.outputSeq - b.outputSeq);

      target.reset();
      target.resize(snapshot.cols, snapshot.rows);
      target.write(snapshot.data, () => {
        // callback 触发前若发生新 startSnapshotRequest / applySnapshot, generation 已推进,
        // 旧 replay frames 属于上一窗口, 不能再写到 target。
        if (myGeneration !== snapshotGeneration) return;
        for (const frame of replayFrames) {
          pendingFrames.set(frame.outputSeq, frame.data);
        }
        flushContiguousFrames(target);
      });

      return { applied: true, replayedFrames: replayFrames.length };
    },
  };
}
