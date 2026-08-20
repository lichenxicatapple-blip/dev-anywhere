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
  // Wait until writes already submitted to the terminal parser have settled. Recovery uses this
  // before reset so an old queued write cannot land after the authoritative snapshot reset.
  barrier?: (callback: WriteCallback) => void;
  // Reconnect may skip an identical snapshot only when the preserved target still has the same
  // geometry. A local fit/font resize while offline must force an authoritative re-apply.
  getDimensions?: () => { cols: number; rows: number } | null;
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

interface StartSnapshotRequestOptions {
  preserveTargetIfUnchanged?: boolean;
}

type SnapshotResult =
  | { applied: true; replayedFrames: number }
  | { applied: false; reason: "stale_snapshot" | "no_active_request" };

interface PtyRecoveryController {
  startSnapshotRequest: (options?: StartSnapshotRequestOptions) => string;
  hasAppliedSnapshot: () => boolean;
  hasPendingGap: () => boolean;
  handleBinaryFrame: (
    frame: { data: Uint8Array; outputSeq: number },
    target: PtyRenderTarget,
  ) => { written: boolean; hasGap: boolean };
  applySnapshot: (
    snapshot: PtySnapshotMessage,
    target: PtyRenderTarget,
    onReplaySettled?: (hasGap: boolean) => void,
  ) => SnapshotResult;
}

function createSnapshotRequestPageScope(): string {
  const values = new Uint32Array(4);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const SNAPSHOT_REQUEST_PAGE_SCOPE = createSnapshotRequestPageScope();
let snapshotControllerSeq = 0;

export function createPtyRecoveryController(
  options: PtyRecoveryOptions = {},
): PtyRecoveryController {
  let seq = 0;
  const controllerScope = `${SNAPSHOT_REQUEST_PAGE_SCOPE}-${++snapshotControllerSeq}`;
  // Relay 会把 proxy 的快照广播给绑定到同一开发机的所有客户端。requestId 必须跨
  // 页面和 controller 唯一，接收方才能拒绝其他客户端请求产生的同 session 快照。
  const requestIdFactory =
    options.requestIdFactory ?? (() => `pty-snapshot-${controllerScope}-${++seq}`);

  let activeRequestId: string | null = null;
  let snapshotApplied = false;
  let frameBuffer: Array<{ data: Uint8Array; outputSeq: number }> = [];
  const pendingFrames = new Map<number, Uint8Array>();
  let appliedOutputSeq = 0;
  let appliedCols: number | null = null;
  let appliedRows: number | null = null;
  let preservedTarget: {
    outputSeq: number;
    cols: number;
    rows: number;
  } | null = null;
  // 每次 startSnapshotRequest / applySnapshot 都 ++; applySnapshot 把当前值塞进异步 write
  // callback 闭包, callback 触发时若 generation 已被新 startSnapshotRequest 推进, 说明
  // 期间发生了新一轮 recovery, 旧 replay frames 不能再写到 target——会污染新窗口。
  let snapshotGeneration = 0;
  let targetMayHaveQueuedWrites = false;

  const settleTarget = (target: PtyRenderTarget, callback: WriteCallback): void => {
    if (target.barrier) {
      target.barrier(callback);
      return;
    }
    callback();
  };

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
    startSnapshotRequest(requestOptions = {}) {
      if (
        requestOptions.preserveTargetIfUnchanged &&
        snapshotApplied &&
        appliedCols !== null &&
        appliedRows !== null
      ) {
        preservedTarget = {
          outputSeq: appliedOutputSeq,
          cols: appliedCols,
          rows: appliedRows,
        };
      } else if (!requestOptions.preserveTargetIfUnchanged) {
        preservedTarget = null;
      }
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

    applySnapshot(snapshot, target, onReplaySettled) {
      if (!activeRequestId) {
        return { applied: false, reason: "no_active_request" };
      }
      if (snapshot.requestId !== activeRequestId) {
        return { applied: false, reason: "stale_snapshot" };
      }

      pendingFrames.clear();
      activeRequestId = null;
      snapshotGeneration += 1;
      const myGeneration = snapshotGeneration;
      const replayFramesAtApply = frameBuffer
        .filter((frame) => frame.outputSeq > snapshot.outputSeq)
        .sort((a, b) => a.outputSeq - b.outputSeq);
      const targetDimensions = target.getDimensions?.() ?? null;

      const canReuseTarget =
        preservedTarget !== null &&
        preservedTarget.outputSeq === snapshot.outputSeq &&
        preservedTarget.cols === snapshot.cols &&
        preservedTarget.rows === snapshot.rows &&
        targetDimensions?.cols === snapshot.cols &&
        targetDimensions.rows === snapshot.rows &&
        replayFramesAtApply.length === 0;
      preservedTarget = null;
      if (canReuseTarget) {
        frameBuffer = [];
        snapshotApplied = true;
        appliedOutputSeq = snapshot.outputSeq;
        appliedCols = snapshot.cols;
        appliedRows = snapshot.rows;
        onReplaySettled?.(false);
        return { applied: true, replayedFrames: 0 };
      }

      // Keep snapshotApplied=false while the old parser queue drains and the snapshot is parsed.
      // Binary frames arriving in either window stay in frameBuffer and are replayed afterwards.
      const applyAuthoritativeSnapshot = (): void => {
        if (myGeneration !== snapshotGeneration) return;
        targetMayHaveQueuedWrites = true;
        target.reset();
        target.resize(snapshot.cols, snapshot.rows);
        target.write(snapshot.data, () => {
          // callback 触发前若发生新 startSnapshotRequest / applySnapshot, generation 已推进,
          // 旧 replay frames 属于上一窗口, 不能再写到 target。
          if (myGeneration !== snapshotGeneration) return;
          const replayFrames = frameBuffer
            .filter((frame) => frame.outputSeq > snapshot.outputSeq)
            .sort((a, b) => a.outputSeq - b.outputSeq);
          frameBuffer = [];
          snapshotApplied = true;
          appliedOutputSeq = snapshot.outputSeq;
          appliedCols = snapshot.cols;
          appliedRows = snapshot.rows;
          for (const frame of replayFrames) {
            pendingFrames.set(frame.outputSeq, frame.data);
          }
          flushContiguousFrames(target);
          onReplaySettled?.(pendingFrames.size > 0);
        });
      };
      if (targetMayHaveQueuedWrites) {
        settleTarget(target, applyAuthoritativeSnapshot);
      } else {
        applyAuthoritativeSnapshot();
      }

      return { applied: true, replayedFrames: replayFramesAtApply.length };
    },
  };
}
