import type { PtyRenderTarget } from "./pty-recovery";

const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;

interface PtyFrameWriteBufferOptions {
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
  maxBatchBytes?: number;
}

interface PtyFrameWriteBuffer {
  target: PtyRenderTarget;
  clear: () => void;
  // Run after every render operation already enqueued at the time of this call has settled. Later
  // live output is appended after this explicit queue boundary and cannot starve the fence.
  fence: (callback: () => void) => void;
  dispose: () => void;
}

interface PendingWrite {
  data: Uint8Array;
  callback?: () => void;
}

interface BinaryBatch {
  kind: "binary";
  writes: PendingWrite[];
  byteLength: number;
}

type QueuedOperation =
  | BinaryBatch
  | { kind: "string"; data: string; callback?: () => void }
  | { kind: "reset" }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "barrier"; callback: () => void }
  | { kind: "fence"; callback: () => void };

function mergeWrites(batch: BinaryBatch): Uint8Array {
  const onlyWrite = batch.writes[0];
  if (batch.writes.length === 1 && onlyWrite) return onlyWrite.data;

  const merged = new Uint8Array(batch.byteLength);
  let offset = 0;
  for (const write of batch.writes) {
    merged.set(write.data, offset);
    offset += write.data.byteLength;
  }
  return merged;
}

/**
 * Serializes every xterm render operation and batches adjacent binary frames at a paint boundary.
 *
 * xterm's write callback is the parser-completion boundary. Waiting for it before applying a
 * resize/reset/string snapshot prevents a late parser task from crossing a geometry or recovery
 * boundary. A control operation always splits binary batches, preserving the producer's exact
 * `bytes -> resize -> bytes` order.
 */
export function createPtyFrameWriteBuffer(
  target: PtyRenderTarget,
  options: PtyFrameWriteBufferOptions = {},
): PtyFrameWriteBuffer {
  const {
    onFramePending,
    onFrameWritten,
    schedule = (callback) => requestAnimationFrame(callback),
    cancel = (handle) => cancelAnimationFrame(handle),
    maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  } = options;

  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
    throw new RangeError("maxBatchBytes must be a positive safe integer");
  }

  let disposed = false;
  let active = false;
  let scheduledFrame: number | null = null;
  let scheduledBatch: BinaryBatch | null = null;
  let queue: QueuedOperation[] = [];

  const processNext = (): void => {
    if (disposed || active || scheduledFrame !== null || queue.length === 0) return;

    const operation = queue[0]!;
    if (operation.kind === "binary") {
      scheduledBatch = operation;
      scheduledFrame = schedule(() => {
        if (disposed || scheduledBatch !== operation || queue[0] !== operation) return;
        scheduledFrame = null;
        scheduledBatch = null;
        queue.shift();
        active = true;
        let batchCompleted = false;
        const completeBatch = (): void => {
          if (batchCompleted) return;
          batchCompleted = true;
          active = false;
          processNext();
        };

        try {
          target.write(mergeWrites(operation), () => {
            try {
              if (!disposed) {
                for (const write of operation.writes) write.callback?.();
                onFrameWritten?.();
              }
            } finally {
              completeBatch();
            }
          });
        } catch (error) {
          completeBatch();
          throw error;
        }
      });
      return;
    }

    queue.shift();
    active = true;
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      active = false;
      processNext();
    };

    switch (operation.kind) {
      case "string":
        try {
          target.write(operation.data, () => {
            try {
              if (!disposed) operation.callback?.();
            } finally {
              complete();
            }
          });
        } catch (error) {
          complete();
          throw error;
        }
        break;
      case "reset":
        try {
          target.reset();
        } finally {
          complete();
        }
        break;
      case "resize":
        try {
          target.resize(operation.cols, operation.rows);
        } finally {
          complete();
        }
        break;
      case "barrier":
        if (target.barrier) {
          try {
            target.barrier(() => {
              try {
                if (!disposed) operation.callback();
              } finally {
                complete();
              }
            });
          } catch (error) {
            complete();
            throw error;
          }
        } else {
          try {
            if (!disposed) operation.callback();
          } finally {
            complete();
          }
        }
        break;
      case "fence":
        try {
          if (!disposed) operation.callback();
        } finally {
          complete();
        }
        break;
    }
  };

  const enqueue = (operation: QueuedOperation): void => {
    if (disposed) return;
    queue.push(operation);
    processNext();
  };

  const enqueueBinary = (data: Uint8Array, callback?: () => void): void => {
    if (disposed) return;
    const tail = queue.at(-1);
    const canAppend =
      tail?.kind === "binary" &&
      tail.byteLength <= maxBatchBytes &&
      data.byteLength <= maxBatchBytes - tail.byteLength;

    if (canAppend) {
      tail.writes.push({ data, ...(callback ? { callback } : {}) });
      tail.byteLength += data.byteLength;
      return;
    }

    const batch: BinaryBatch = {
      kind: "binary",
      writes: [{ data, ...(callback ? { callback } : {}) }],
      byteLength: data.byteLength,
    };
    queue.push(batch);
    onFramePending?.();
    processNext();
  };

  const clear = (): void => {
    queue = [];
    scheduledBatch = null;
    if (scheduledFrame !== null) {
      cancel(scheduledFrame);
      scheduledFrame = null;
    }
  };

  return {
    target: {
      reset: () => enqueue({ kind: "reset" }),
      resize: (cols, rows) => enqueue({ kind: "resize", cols, rows }),
      write: (data, callback) => {
        if (typeof data === "string") {
          enqueue({ kind: "string", data, ...(callback ? { callback } : {}) });
          return;
        }
        enqueueBinary(data, callback);
      },
      barrier: (callback) => enqueue({ kind: "barrier", callback }),
      ...(target.getDimensions ? { getDimensions: target.getDimensions } : {}),
    },
    clear,
    fence: (callback) => enqueue({ kind: "fence", callback }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
