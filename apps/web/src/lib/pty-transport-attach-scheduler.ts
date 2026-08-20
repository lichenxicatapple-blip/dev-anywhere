interface PtyTransportAttachSchedulerOptions {
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
}

export interface PtyTransportAttachScheduler {
  enqueue: (key: string, priority: "active" | "background", attach: () => void) => () => void;
  dispose: () => void;
}

interface QueuedAttach {
  attach: () => void;
  token: symbol;
}

/**
 * Reconnecting a proxy can wake every kept-alive PTY at once. Each attach immediately requests a
 * snapshot, so a burst turns into a burst of xterm parsing/layout work when the responses arrive.
 * Active PTYs must recover immediately; background PTYs are deliberately admitted one per paint.
 */
export function createPtyTransportAttachScheduler(
  options: PtyTransportAttachSchedulerOptions = {},
): PtyTransportAttachScheduler {
  const {
    schedule = (callback) => requestAnimationFrame(callback),
    cancel = (handle) => cancelAnimationFrame(handle),
  } = options;
  const queue = new Map<string, QueuedAttach>();
  let frame: number | null = null;
  let disposed = false;

  const scheduleNext = (): void => {
    if (disposed || frame !== null || queue.size === 0) return;
    frame = schedule(() => {
      frame = null;
      if (disposed) return;
      const next = queue.entries().next().value as [string, QueuedAttach] | undefined;
      if (!next) return;
      const [key, entry] = next;
      queue.delete(key);
      entry.attach();
      scheduleNext();
    });
  };

  return {
    enqueue(key, priority, attach) {
      if (disposed) return () => {};
      const token = Symbol(key);
      queue.delete(key);

      if (priority === "active") {
        attach();
        return () => {};
      }

      queue.set(key, { attach, token });
      scheduleNext();
      return () => {
        const queued = queue.get(key);
        if (queued?.token === token) queue.delete(key);
      };
    },
    dispose() {
      disposed = true;
      queue.clear();
      if (frame !== null) cancel(frame);
      frame = null;
    },
  };
}

let sharedScheduler: PtyTransportAttachScheduler | null = null;

export function schedulePtyTransportAttach(
  sessionId: string,
  priority: "active" | "background",
  attach: () => void,
): () => void {
  sharedScheduler ??= createPtyTransportAttachScheduler();
  return sharedScheduler.enqueue(sessionId, priority, attach);
}
