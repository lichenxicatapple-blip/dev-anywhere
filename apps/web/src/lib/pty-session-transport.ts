import { createPtyFrameWriteBuffer } from "./pty-frame-write-buffer";
import { markPtyOutputReceived, markPtyOutputWritten } from "./pty-input-latency-trace";
import { createPtyRecoveryController, type PtyRenderTarget } from "./pty-recovery";

type RelayMessage = Record<string, unknown>;

export interface PtyWebSocketLike {
  send: (data: string) => boolean;
  subscribeBinary: (
    sessionId: string,
    handler: (data: Uint8Array, outputSeq: number) => void,
  ) => () => void;
}

export interface PtyRelayLike {
  onMessage: (handler: (msg: RelayMessage) => void) => () => void;
}

interface PtySessionTransportOptions {
  sessionId: string;
  ws: PtyWebSocketLike;
  relay: PtyRelayLike;
  target: PtyRenderTarget;
  retryDelayMs?: number;
  slowNoticeDelayMs?: number;
  // outputSeq gap 持续这么久仍未补齐就主动重订 snapshot。短于这个值能消化乱序，
  // 长于这个值才认定服务端真丢帧（典型场景：proxy↔relay 闪断时的 sendBinary 丢弃）。
  gapRecoveryDelayMs?: number;
  scheduleReady?: (callback: () => void) => void;
  scheduleFrameFlush?: (callback: FrameRequestCallback) => number;
  cancelFrameFlush?: (handle: number) => void;
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  onReady?: () => void;
  onSubscribeDelayed?: () => void;
  onSubscribeStarted?: () => void;
  onGapRecovery?: () => void;
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
    retryDelayMs = 30_000,
    slowNoticeDelayMs = 10_000,
    gapRecoveryDelayMs = 2_000,
    scheduleReady = (callback) => requestAnimationFrame(callback),
    scheduleFrameFlush,
    cancelFrameFlush,
    onFramePending,
    onFrameWritten,
    onReady,
    onSubscribeDelayed,
    onSubscribeStarted,
    onGapRecovery,
  } = options;

  const recovery = createPtyRecoveryController();
  const tracedTarget: PtyRenderTarget = {
    reset: () => target.reset(),
    resize: (cols, rows) => target.resize(cols, rows),
    write: (data, callback) => {
      target.write(data, () => {
        if (data instanceof Uint8Array) {
          markPtyOutputWritten(sessionId, data.byteLength);
        }
        callback?.();
      });
    },
  };
  const frameWriter = createPtyFrameWriteBuffer(tracedTarget, {
    onFramePending,
    onFrameWritten,
    schedule: scheduleFrameFlush,
    cancel: cancelFrameFlush,
  });
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let slowNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let gapRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribeDelayedReported = false;

  const clearRetry = (): void => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearSlowNotice = (): void => {
    if (!slowNoticeTimer) return;
    clearTimeout(slowNoticeTimer);
    slowNoticeTimer = null;
  };

  const clearGapRecovery = (): void => {
    if (!gapRecoveryTimer) return;
    clearTimeout(gapRecoveryTimer);
    gapRecoveryTimer = null;
  };

  // outputSeq gap 持续超过阈值即认为服务端确实丢帧（不是乱序），主动重订 snapshot。
  // 不直接复用 startSnapshotSubscribe 调用方注释：这里要求保留 frameWriter 当前缓冲，
  // startSnapshotSubscribe 会 frameWriter.clear()，相当于在等 snapshot 期间画面再清一次。
  // 这里的语义是"流卡死了，从服务端拿权威状态重置"，clear 是必要副作用。
  const armGapRecoveryTimer = (): void => {
    if (gapRecoveryTimer) return;
    gapRecoveryTimer = setTimeout(() => {
      gapRecoveryTimer = null;
      if (disposed || !recovery.hasPendingGap()) return;
      onGapRecovery?.();
      startSnapshotSubscribe();
    }, gapRecoveryDelayMs);
  };

  const requestSnapshot = (): void => {
    const requestId = recovery.startSnapshotRequest();
    ws.send(JSON.stringify({ type: "session_subscribe", sessionId, requestId }));
  };

  const scheduleSnapshotRetry = (): void => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || recovery.hasAppliedSnapshot()) return;
      requestSnapshot();
      scheduleSnapshotRetry();
    }, retryDelayMs);
  };

  const scheduleSlowNotice = (): void => {
    slowNoticeTimer = setTimeout(() => {
      slowNoticeTimer = null;
      if (disposed || recovery.hasAppliedSnapshot() || subscribeDelayedReported) return;
      subscribeDelayedReported = true;
      onSubscribeDelayed?.();
    }, slowNoticeDelayMs);
  };

  const startSnapshotSubscribe = (): void => {
    if (disposed) return;
    clearRetry();
    clearSlowNotice();
    clearGapRecovery();
    frameWriter.clear();
    subscribeDelayedReported = false;
    onSubscribeStarted?.();
    requestSnapshot();
    scheduleSnapshotRetry();
    scheduleSlowNotice();
  };

  const unsubBinary = ws.subscribeBinary(sessionId, (data, outputSeq) => {
    if (disposed) return;
    markPtyOutputReceived(sessionId, data, outputSeq);
    const result = recovery.handleBinaryFrame({ data, outputSeq }, frameWriter.target);
    if (result.hasGap) {
      armGapRecoveryTimer();
    } else {
      clearGapRecovery();
    }
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
    clearSlowNotice();
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
      clearSlowNotice();
      clearGapRecovery();
      frameWriter.dispose();
      unsubBinary();
      unsubRelay();
    },
  };
}
