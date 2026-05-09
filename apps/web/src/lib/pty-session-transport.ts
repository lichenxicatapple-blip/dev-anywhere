import { createPtyFrameWriteBuffer } from "./pty-frame-write-buffer";
import { PtyRecoveryController, type PtyRenderTarget } from "./pty-recovery";

type RelayMessage = Record<string, unknown>;

interface PtyWebSocketLike {
  send: (data: string) => boolean;
  subscribeBinary: (
    sessionId: string,
    handler: (data: Uint8Array, outputSeq: number) => void,
  ) => () => void;
}

interface PtyRelayLike {
  onMessage: (handler: (msg: RelayMessage) => void) => () => void;
}

interface PtySessionTransportOptions {
  sessionId: string;
  ws: PtyWebSocketLike;
  relay: PtyRelayLike;
  target: PtyRenderTarget;
  retryDelayMs?: number;
  maxRetries?: number;
  scheduleReady?: (callback: () => void) => void;
  scheduleFrameFlush?: (callback: FrameRequestCallback) => number;
  cancelFrameFlush?: (handle: number) => void;
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  onReady?: () => void;
  onSubscribeExhausted?: () => void;
  onSubscribeStarted?: () => void;
}

interface PtySessionTransport {
  dispose: () => void;
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function attachPtySessionTransport(
  options: PtySessionTransportOptions,
): PtySessionTransport {
  const {
    sessionId,
    ws,
    relay,
    target,
    retryDelayMs = 3000,
    maxRetries = 3,
    scheduleReady = (callback) => requestAnimationFrame(callback),
    scheduleFrameFlush,
    cancelFrameFlush,
    onFramePending,
    onFrameWritten,
    onReady,
    onSubscribeExhausted,
    onSubscribeStarted,
  } = options;

  const recovery = new PtyRecoveryController();
  const frameWriter = createPtyFrameWriteBuffer(target, {
    onFramePending,
    onFrameWritten,
    schedule: scheduleFrameFlush,
    cancel: cancelFrameFlush,
  });
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;

  const clearRetry = (): void => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const requestSnapshot = (): void => {
    const requestId = recovery.startSnapshotRequest();
    ws.send(JSON.stringify({ type: "session_subscribe", sessionId, requestId }));
  };

  const scheduleSnapshotRetry = (): void => {
    requestSnapshot();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || recovery.hasAppliedSnapshot()) return;
      if (retryCount >= maxRetries) {
        onSubscribeExhausted?.();
        return;
      }
      retryCount += 1;
      scheduleSnapshotRetry();
    }, retryDelayMs);
  };

  const startSnapshotSubscribe = (): void => {
    if (disposed) return;
    clearRetry();
    frameWriter.clear();
    retryCount = 0;
    onSubscribeStarted?.();
    scheduleSnapshotRetry();
  };

  const unsubBinary = ws.subscribeBinary(sessionId, (data, outputSeq) => {
    if (disposed) return;
    recovery.handleBinaryFrame({ data, outputSeq }, frameWriter.target);
  });

  const unsubRelay = relay.onMessage((msg) => {
    if (disposed || msg.sessionId !== sessionId) return;
    if (msg.type === "terminal_resize") {
      frameWriter.target.resize(msg.cols as number, msg.rows as number);
      startSnapshotSubscribe();
      return;
    }
    if (msg.type !== "session_snapshot") return;

    const result = recovery.applySnapshot(
      {
        requestId: msg.requestId as string | undefined,
        cols: msg.cols as number,
        rows: msg.rows as number,
        data: msg.data as string,
        outputSeq: msg.outputSeq as number,
      },
      frameWriter.target,
    );
    if (!result.applied) return;
    clearRetry();
    scheduleReady(() => {
      if (!disposed) onReady?.();
    });
  });

  startSnapshotSubscribe();

  return {
    flushOutput: () => frameWriter.flush(),
    setOutputPaused: (value) => frameWriter.setPaused(value),
    dispose: () => {
      disposed = true;
      clearRetry();
      frameWriter.dispose();
      unsubBinary();
      unsubRelay();
    },
  };
}
