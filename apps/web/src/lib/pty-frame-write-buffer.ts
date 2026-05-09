import type { PtyRenderTarget } from "./pty-recovery";

interface PtyFrameWriteBufferOptions {
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  paused?: boolean;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
}

interface PtyFrameWriteBuffer {
  target: PtyRenderTarget;
  clear: () => void;
  flush: () => void;
  setPaused: (value: boolean) => void;
  dispose: () => void;
}

export function createPtyFrameWriteBuffer(
  target: PtyRenderTarget,
  options: PtyFrameWriteBufferOptions = {},
): PtyFrameWriteBuffer {
  const {
    onFramePending,
    onFrameWritten,
    paused: initialPaused = false,
    schedule = (callback) => requestAnimationFrame(callback),
    cancel = (handle) => cancelAnimationFrame(handle),
  } = options;
  let frame: number | null = null;
  let disposed = false;
  let paused = initialPaused;
  let pendingBytes: Uint8Array[] = [];
  let pendingCallbacks: Array<() => void> = [];

  const clearPending = (): void => {
    pendingBytes = [];
    pendingCallbacks = [];
    if (frame !== null) {
      cancel(frame);
      frame = null;
    }
  };

  const flush = (): void => {
    frame = null;
    if (disposed || pendingBytes.length === 0) return;
    const bytes = pendingBytes;
    const callbacks = pendingCallbacks;
    pendingBytes = [];
    pendingCallbacks = [];
    const total = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of bytes) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    target.write(merged, () => {
      for (const callback of callbacks) callback();
      onFrameWritten?.();
    });
  };

  const scheduleFlush = (): void => {
    if (disposed || paused || frame !== null || pendingBytes.length === 0) return;
    frame = schedule(flush);
  };

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
        const wasEmpty = pendingBytes.length === 0;
        pendingBytes.push(data);
        if (callback) pendingCallbacks.push(callback);
        if (wasEmpty) onFramePending?.();
        scheduleFlush();
      },
    },
    clear: clearPending,
    flush: () => {
      if (frame !== null) {
        cancel(frame);
        frame = null;
      }
      flush();
    },
    setPaused: (value) => {
      if (paused === value) return;
      paused = value;
      if (!paused) scheduleFlush();
    },
    dispose: () => {
      disposed = true;
      clearPending();
    },
  };
}
