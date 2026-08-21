import type { PtyRenderTarget } from "./pty-recovery";

interface PtyFrameWriteBufferOptions {
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
}

interface PtyFrameWriteBuffer {
  target: PtyRenderTarget;
  clear: () => void;
  // Run after every binary write that was already enqueued at the time of this call has reached
  // the render target's write callback. Later frames belong to a new live-output window and do
  // not extend this fence, so a continuously active PTY cannot starve readiness forever.
  fence: (callback: () => void) => void;
  dispose: () => void;
}

interface PendingWrite {
  data: Uint8Array;
  callback?: () => void;
  sequence: number;
}

interface WriteFence {
  sequence: number;
  callback: () => void;
}

export function createPtyFrameWriteBuffer(
  target: PtyRenderTarget,
  options: PtyFrameWriteBufferOptions = {},
): PtyFrameWriteBuffer {
  const {
    onFramePending,
    onFrameWritten,
    schedule = (callback) => requestAnimationFrame(callback),
    cancel = (handle) => cancelAnimationFrame(handle),
  } = options;
  let frame: number | null = null;
  let disposed = false;
  let generation = 0;
  let nextWriteSequence = 0;
  let completedWriteSequence = 0;
  let pendingWrites: PendingWrite[] = [];
  let completedBatches = new Map<number, number>();
  let fences: WriteFence[] = [];

  const drainFences = (): void => {
    if (fences.length === 0) return;
    const settled: WriteFence[] = [];
    const waiting: WriteFence[] = [];
    for (const fence of fences) {
      (fence.sequence <= completedWriteSequence ? settled : waiting).push(fence);
    }
    fences = waiting;
    for (const fence of settled) fence.callback();
  };

  const clearPending = (): void => {
    pendingWrites = [];
    if (frame !== null) {
      cancel(frame);
      frame = null;
    }
    // Writes already submitted to xterm cannot be cancelled. Move future buffering/fences to a
    // fresh generation so their eventual callbacks cannot satisfy a fence for the new snapshot.
    generation += 1;
    nextWriteSequence = 0;
    completedWriteSequence = 0;
    completedBatches = new Map();
    fences = [];
  };

  const flush = (): void => {
    frame = null;
    if (disposed || pendingWrites.length === 0) return;
    const writes = pendingWrites;
    const batchGeneration = generation;
    const firstSequence = writes[0]!.sequence;
    const lastSequence = writes.at(-1)!.sequence;
    pendingWrites = [];
    const total = writes.reduce((sum, write) => sum + write.data.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const write of writes) {
      merged.set(write.data, offset);
      offset += write.data.byteLength;
    }
    target.write(merged, () => {
      for (const write of writes) write.callback?.();
      onFrameWritten?.();
      if (disposed || batchGeneration !== generation) return;
      completedBatches.set(firstSequence, lastSequence);
      let completedBatchEnd = completedBatches.get(completedWriteSequence + 1);
      while (completedBatchEnd !== undefined) {
        completedBatches.delete(completedWriteSequence + 1);
        completedWriteSequence = completedBatchEnd;
        completedBatchEnd = completedBatches.get(completedWriteSequence + 1);
      }
      drainFences();
    });
  };

  const scheduleFlush = (): void => {
    if (disposed || frame !== null || pendingWrites.length === 0) return;
    frame = schedule(flush);
  };

  const fenceCurrentWrites = (callback: () => void): void => {
    if (disposed) return;
    const sequence = nextWriteSequence;
    if (sequence <= completedWriteSequence) {
      callback();
      return;
    }
    fences.push({ sequence, callback });
  };

  const targetBarrier = target.barrier;

  return {
    target: {
      reset: () => {
        clearPending();
        target.reset();
      },
      resize: (cols, rows) => target.resize(cols, rows),
      write: (data, callback) => {
        if (typeof data === "string") {
          target.write(data, callback);
          return;
        }
        if (disposed) return;
        const wasEmpty = pendingWrites.length === 0;
        pendingWrites.push({
          data,
          ...(callback ? { callback } : {}),
          sequence: ++nextWriteSequence,
        });
        if (wasEmpty) onFramePending?.();
        scheduleFlush();
      },
      ...(targetBarrier
        ? {
            barrier: (callback: () => void) => {
              fenceCurrentWrites(() => targetBarrier(callback));
            },
          }
        : {}),
      ...(target.getDimensions ? { getDimensions: target.getDimensions } : {}),
    },
    clear: clearPending,
    fence: fenceCurrentWrites,
    dispose: () => {
      disposed = true;
      clearPending();
    },
  };
}
