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
  pause: () => void;
  resume: () => void;
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
    barrier: (callback) => target.write("", callback),
    getDimensions: () => {
      const reported = target.getDimensions?.();
      if (reported) return reported;
      const candidate = target as PtyRenderTarget & { cols?: unknown; rows?: unknown };
      return typeof candidate.cols === "number" && typeof candidate.rows === "number"
        ? { cols: candidate.cols, rows: candidate.rows }
        : null;
    },
  };
  const frameWriter = createPtyFrameWriteBuffer(tracedTarget, {
    onFramePending,
    onFrameWritten,
    schedule: scheduleFrameFlush,
    cancel: cancelFrameFlush,
  });
  let disposed = false;
  let paused = false;
  let preserveTargetForCurrentSubscribe = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let slowNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let gapRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribeDelayedReported = false;
  let currentRequestId: string | null = null;
  let readyCycle = 0;
  let readyAttempt = 0;
  let readyAwaiting = false;
  let readyGateInFlight = false;

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

  const invalidateReadyGate = (): void => {
    readyCycle += 1;
    readyAttempt += 1;
    readyAwaiting = false;
    readyGateInFlight = false;
  };

  const cancelReadyAttemptForGap = (): void => {
    readyAttempt += 1;
    readyGateInFlight = false;
  };

  const tryAdvanceReady = (): void => {
    if (
      disposed ||
      paused ||
      !readyAwaiting ||
      readyGateInFlight ||
      !recovery.hasAppliedSnapshot() ||
      recovery.hasPendingGap()
    ) {
      return;
    }

    readyGateInFlight = true;
    const cycle = readyCycle;
    const attempt = ++readyAttempt;
    // Capture only replay writes already enqueued now. Live frames arriving afterwards must not
    // keep a busy terminal in the syncing state forever.
    frameWriter.fence(() => {
      if (
        disposed ||
        paused ||
        cycle !== readyCycle ||
        attempt !== readyAttempt ||
        !readyAwaiting
      ) {
        return;
      }
      if (recovery.hasPendingGap()) {
        readyGateInFlight = false;
        return;
      }
      scheduleReady(() => {
        if (
          disposed ||
          paused ||
          cycle !== readyCycle ||
          attempt !== readyAttempt ||
          !readyAwaiting
        ) {
          return;
        }
        if (recovery.hasPendingGap()) {
          readyGateInFlight = false;
          return;
        }
        readyGateInFlight = false;
        readyAwaiting = false;
        onReady?.();
      });
    });
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

  const beginSnapshotRequest = (): string => {
    const requestId = recovery.startSnapshotRequest({
      preserveTargetIfUnchanged: preserveTargetForCurrentSubscribe,
    });
    currentRequestId = requestId;
    ws.send(JSON.stringify({ type: "session_subscribe", sessionId, requestId }));
    return requestId;
  };

  const scheduleSnapshotRetry = (requestId: string): void => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || paused || recovery.hasAppliedSnapshot() || currentRequestId !== requestId) {
        return;
      }
      // This is another delivery attempt for the same logical request. A slow first response must
      // remain valid, and frames accumulated while it is in flight must stay in the same window.
      ws.send(JSON.stringify({ type: "session_subscribe", sessionId, requestId }));
      scheduleSnapshotRetry(requestId);
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

  const startSnapshotSubscribe = (preserveTargetIfUnchanged = false): void => {
    if (disposed || paused) return;
    invalidateReadyGate();
    clearRetry();
    clearSlowNotice();
    clearGapRecovery();
    if (!preserveTargetIfUnchanged) frameWriter.clear();
    preserveTargetForCurrentSubscribe = preserveTargetIfUnchanged;
    subscribeDelayedReported = false;
    onSubscribeStarted?.();
    const requestId = beginSnapshotRequest();
    scheduleSnapshotRetry(requestId);
    scheduleSlowNotice();
  };

  const handleRenderEventResult = (result: { hasGap: boolean }): void => {
    if (result.hasGap) {
      if (readyAwaiting && readyGateInFlight) cancelReadyAttemptForGap();
      armGapRecoveryTimer();
      return;
    }
    clearGapRecovery();
    tryAdvanceReady();
  };

  const unsubBinary = ws.subscribeBinary(sessionId, (data, outputSeq) => {
    if (disposed || paused) return;
    markPtyOutputReceived(sessionId, data, outputSeq);
    const result = recovery.handleBinaryFrame({ data, outputSeq }, frameWriter.target);
    handleRenderEventResult(result);
  });

  const unsubRelay = relay.onMessage((msg) => {
    if (disposed || paused || msg.sessionId !== sessionId) return;
    if (msg.type === "terminal_resize") {
      if (
        typeof msg.cols !== "number" ||
        typeof msg.rows !== "number" ||
        typeof msg.outputSeq !== "number"
      ) {
        return;
      }
      const result = recovery.handleResize(
        { cols: msg.cols, rows: msg.rows, outputSeq: msg.outputSeq },
        frameWriter.target,
      );
      handleRenderEventResult(result);
      return;
    }
    if (msg.type !== "session_snapshot") return;
    if (typeof msg.requestId !== "string") return;

    const result = recovery.applySnapshot(
      {
        requestId: msg.requestId as string,
        cols: msg.cols as number,
        rows: msg.rows as number,
        data: msg.data as string,
        outputSeq: msg.outputSeq as number,
      },
      frameWriter.target,
      (hasGap) => {
        if (disposed || paused) return;
        readyAwaiting = true;
        if (hasGap) {
          cancelReadyAttemptForGap();
          armGapRecoveryTimer();
        } else {
          clearGapRecovery();
          tryAdvanceReady();
        }
        clearSlowNotice();
      },
    );
    if (!result.applied) return;
    // A valid response is now being parsed. Stop delivery retries immediately rather than sending
    // redundant large snapshots while the terminal parser drains.
    currentRequestId = null;
    clearRetry();
  });

  startSnapshotSubscribe();

  return {
    pause: () => {
      if (disposed || paused) return;
      paused = true;
      currentRequestId = null;
      invalidateReadyGate();
      clearRetry();
      clearSlowNotice();
      clearGapRecovery();
    },
    resume: () => {
      if (disposed || !paused) return;
      paused = false;
      startSnapshotSubscribe(true);
    },
    dispose: () => {
      disposed = true;
      paused = true;
      currentRequestId = null;
      invalidateReadyGate();
      clearRetry();
      clearSlowNotice();
      clearGapRecovery();
      frameWriter.dispose();
      unsubBinary();
      unsubRelay();
    },
  };
}
