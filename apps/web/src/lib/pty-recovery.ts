type WriteCallback = () => void;

// A snapshot request can stay in flight while the producer keeps rendering. Bound the pre-snapshot
// event tail so a broken connection cannot grow browser memory without limit.
const MAX_EVENT_BUFFER = 5000;
// After a snapshot, out-of-order render events wait here for their missing predecessor. A persistent
// gap is surfaced to the transport, which requests a new authoritative snapshot.
const MAX_PENDING_EVENTS = 1000;

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
  requestId: string;
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

type PtyRenderEvent =
  | { kind: "write"; data: Uint8Array; outputSeq: number }
  | { kind: "resize"; cols: number; rows: number; outputSeq: number };

type SnapshotResult =
  | { applied: true; replayedEvents: number }
  | { applied: false; reason: "stale_snapshot" | "no_active_request" };

interface EventResult {
  written: boolean;
  hasGap: boolean;
}

interface PtyRecoveryController {
  startSnapshotRequest: (options?: StartSnapshotRequestOptions) => string;
  hasAppliedSnapshot: () => boolean;
  hasPendingGap: () => boolean;
  handleBinaryFrame: (
    frame: { data: Uint8Array; outputSeq: number },
    target: PtyRenderTarget,
  ) => EventResult;
  handleResize: (
    resize: { cols: number; rows: number; outputSeq: number },
    target: PtyRenderTarget,
  ) => EventResult;
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
  // Relay uses requestId to route a snapshot to the browser which requested it. It must be unique
  // across controllers and page reloads so a delayed response cannot enter a newer recovery window.
  const requestIdFactory =
    options.requestIdFactory ?? (() => `pty-snapshot-${controllerScope}-${++seq}`);

  let activeRequestId: string | null = null;
  let snapshotApplied = false;
  let eventBuffer: PtyRenderEvent[] = [];
  let droppedBufferedMaxSeq: number | null = null;
  const pendingEvents = new Map<number, PtyRenderEvent>();
  let pendingEventsOverflowed = false;
  let appliedOutputSeq = 0;
  let appliedCols: number | null = null;
  let appliedRows: number | null = null;
  let preservedTarget: {
    outputSeq: number;
    cols: number;
    rows: number;
  } | null = null;
  // Every new request/application advances this generation. Deferred parser callbacks from an
  // older snapshot must not replay their event tail into the new recovery window.
  let snapshotGeneration = 0;
  let targetMayHaveQueuedWrites = false;

  const settleTarget = (target: PtyRenderTarget, callback: WriteCallback): void => {
    if (target.barrier) {
      target.barrier(callback);
      return;
    }
    callback();
  };

  const applyRenderEvent = (event: PtyRenderEvent, target: PtyRenderTarget): void => {
    if (event.kind === "write") {
      target.write(event.data);
      return;
    }
    target.resize(event.cols, event.rows);
    appliedCols = event.cols;
    appliedRows = event.rows;
  };

  const flushContiguousEvents = (target: PtyRenderTarget): number => {
    let written = 0;
    let nextSeq = appliedOutputSeq + 1;
    while (pendingEvents.has(nextSeq)) {
      const event = pendingEvents.get(nextSeq)!;
      pendingEvents.delete(nextSeq);
      appliedOutputSeq = nextSeq;
      applyRenderEvent(event, target);
      written += 1;
      nextSeq += 1;
    }
    return written;
  };

  const hasUnresolvedGap = (): boolean => pendingEvents.size > 0 || pendingEventsOverflowed;

  const trimPendingEvents = (): void => {
    if (pendingEvents.size <= MAX_PENDING_EVENTS) return;
    pendingEventsOverflowed = true;
    // Keep the events nearest to the missing sequence. Dropping by arrival order can discard the
    // very event which would unlock the whole tail; dropping the farthest future events instead
    // lets recovery advance as much as possible before it requests an authoritative snapshot.
    const farthestSequences = [...pendingEvents.keys()].sort((a, b) => b - a);
    const overflow = pendingEvents.size - MAX_PENDING_EVENTS;
    for (let index = 0; index < overflow; index += 1) {
      const sequence = farthestSequences[index];
      if (sequence !== undefined) pendingEvents.delete(sequence);
    }
  };

  const handleRenderEvent = (event: PtyRenderEvent, target: PtyRenderTarget): EventResult => {
    if (!snapshotApplied) {
      eventBuffer.push(event);
      if (eventBuffer.length > MAX_EVENT_BUFFER) {
        const dropped = eventBuffer.splice(0, eventBuffer.length - MAX_EVENT_BUFFER);
        for (const droppedEvent of dropped) {
          droppedBufferedMaxSeq = Math.max(
            droppedBufferedMaxSeq ?? droppedEvent.outputSeq,
            droppedEvent.outputSeq,
          );
        }
      }
      return { written: false, hasGap: false };
    }
    if (event.outputSeq <= appliedOutputSeq) {
      // A stale/duplicate event does not close an existing gap.
      return { written: false, hasGap: hasUnresolvedGap() };
    }
    pendingEvents.set(event.outputSeq, event);
    const written = flushContiguousEvents(target) > 0;
    trimPendingEvents();
    return { written, hasGap: hasUnresolvedGap() };
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
      eventBuffer = [];
      droppedBufferedMaxSeq = null;
      pendingEvents.clear();
      pendingEventsOverflowed = false;
      snapshotGeneration += 1;
      return requestId;
    },

    hasAppliedSnapshot() {
      return snapshotApplied;
    },

    hasPendingGap() {
      return snapshotApplied && hasUnresolvedGap();
    },

    handleBinaryFrame(frame, target) {
      return handleRenderEvent({ kind: "write", ...frame }, target);
    },

    handleResize(resize, target) {
      return handleRenderEvent({ kind: "resize", ...resize }, target);
    },

    applySnapshot(snapshot, target, onReplaySettled) {
      if (!activeRequestId) {
        return { applied: false, reason: "no_active_request" };
      }
      if (snapshot.requestId !== activeRequestId) {
        return { applied: false, reason: "stale_snapshot" };
      }

      pendingEvents.clear();
      activeRequestId = null;
      snapshotGeneration += 1;
      const myGeneration = snapshotGeneration;
      const replayEventsAtApply = eventBuffer
        .filter((event) => event.outputSeq > snapshot.outputSeq)
        .sort((a, b) => a.outputSeq - b.outputSeq);
      const targetDimensions = target.getDimensions?.() ?? null;

      const canReuseTarget =
        preservedTarget !== null &&
        preservedTarget.outputSeq === snapshot.outputSeq &&
        preservedTarget.cols === snapshot.cols &&
        preservedTarget.rows === snapshot.rows &&
        targetDimensions?.cols === snapshot.cols &&
        targetDimensions.rows === snapshot.rows &&
        (droppedBufferedMaxSeq === null || droppedBufferedMaxSeq <= snapshot.outputSeq) &&
        replayEventsAtApply.length === 0;
      preservedTarget = null;
      if (canReuseTarget) {
        eventBuffer = [];
        droppedBufferedMaxSeq = null;
        snapshotApplied = true;
        appliedOutputSeq = snapshot.outputSeq;
        appliedCols = snapshot.cols;
        appliedRows = snapshot.rows;
        onReplaySettled?.(false);
        return { applied: true, replayedEvents: 0 };
      }

      // Keep snapshotApplied=false while the old parser queue drains and the snapshot is parsed.
      // Events arriving in either window stay buffered and replay afterwards.
      const applyAuthoritativeSnapshot = (): void => {
        if (myGeneration !== snapshotGeneration) return;
        targetMayHaveQueuedWrites = true;
        target.reset();
        target.resize(snapshot.cols, snapshot.rows);
        target.write(snapshot.data, () => {
          if (myGeneration !== snapshotGeneration) return;
          const replayEvents = eventBuffer
            .filter((event) => event.outputSeq > snapshot.outputSeq)
            .sort((a, b) => a.outputSeq - b.outputSeq);
          eventBuffer = [];
          snapshotApplied = true;
          appliedOutputSeq = snapshot.outputSeq;
          appliedCols = snapshot.cols;
          appliedRows = snapshot.rows;
          pendingEventsOverflowed =
            droppedBufferedMaxSeq !== null && droppedBufferedMaxSeq > snapshot.outputSeq;
          droppedBufferedMaxSeq = null;
          for (const event of replayEvents) {
            pendingEvents.set(event.outputSeq, event);
          }
          flushContiguousEvents(target);
          trimPendingEvents();
          onReplaySettled?.(hasUnresolvedGap());
        });
      };
      if (targetMayHaveQueuedWrites) {
        settleTarget(target, applyAuthoritativeSnapshot);
      } else {
        applyAuthoritativeSnapshot();
      }

      return { applied: true, replayedEvents: replayEventsAtApply.length };
    },
  };
}
