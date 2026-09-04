interface RelayReconnectLoopOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  attemptTimeoutMs?: number;
}

export interface RelayReconnectLoop {
  start: () => void;
  stop: () => void;
}

export class RelayReconnectAttemptTimeoutError extends Error {
  constructor() {
    super("Relay connection preflight timed out");
    this.name = "RelayReconnectAttemptTimeoutError";
  }
}

// Relay 还没启动时 Web 也可能先被打开。预检失败后在原页重试，
// 成功或得到明确的鉴权结果后 attempt 会 resolve，循环自然停止。
export function createRelayReconnectLoop(
  attempt: (signal: AbortSignal) => Promise<void>,
  options: RelayReconnectLoopOptions = {},
): RelayReconnectLoop {
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
  let enabled = false;
  let generation = 0;
  let runningGeneration: number | null = null;
  let restartRequestedWhileRunning = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAttempt: AbortController | null = null;

  const run = async (myGeneration: number): Promise<void> => {
    if (!enabled || myGeneration !== generation || runningGeneration === myGeneration) return;
    runningGeneration = myGeneration;
    const controller = new AbortController();
    activeAttempt = controller;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        attempt(controller.signal),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            const error = new RelayReconnectAttemptTimeoutError();
            reject(error);
            controller.abort(error);
          }, attemptTimeoutMs);
        }),
      ]);
      retryAttempt = 0;
    } catch {
      if (!enabled || myGeneration !== generation) return;
      const delay = Math.min(initialDelayMs * 2 ** retryAttempt, maxDelayMs);
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run(myGeneration);
      }, delay);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (activeAttempt === controller) activeAttempt = null;
      if (runningGeneration === myGeneration) runningGeneration = null;
      if (
        enabled &&
        myGeneration === generation &&
        restartRequestedWhileRunning &&
        retryTimer === null
      ) {
        restartRequestedWhileRunning = false;
        generation += 1;
        retryAttempt = 0;
        void run(generation);
      }
    }
  };

  return {
    start: () => {
      if (enabled && runningGeneration === generation) {
        // A manual preflight may supersede the loop's current request and fail before that request
        // unwinds. Remember the wake-up so its finally block cannot leave the supervisor dormant.
        restartRequestedWhileRunning = true;
        return;
      }
      if (enabled && retryTimer !== null) return;
      enabled = true;
      generation += 1;
      retryAttempt = 0;
      restartRequestedWhileRunning = false;
      void run(generation);
    },
    stop: () => {
      enabled = false;
      generation += 1;
      retryAttempt = 0;
      restartRequestedWhileRunning = false;
      activeAttempt?.abort(new DOMException("Relay reconnect loop stopped", "AbortError"));
      activeAttempt = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
