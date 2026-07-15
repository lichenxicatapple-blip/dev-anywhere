import type { WorkerRegistry } from "./worker-registry.js";

const CONNECT_RETRY_BASE_MS = 100;
const CONNECT_RETRY_MAX_MS = 1_000;

export class JsonWorkerStartupTimeoutError extends Error {
  constructor() {
    super("JSON worker startup deadline reached");
    this.name = "JsonWorkerStartupTimeoutError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("JSON worker startup aborted");
  }
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Startup aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForJsonWorkerStartup(options: {
  workerRegistry: WorkerRegistry;
  sessionId: string;
  socketPath: string;
  deadlineAt: number;
  signal: AbortSignal;
}): Promise<void> {
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);
    const remainingBeforeDelay = options.deadlineAt - Date.now();
    if (remainingBeforeDelay <= 0) throw new JsonWorkerStartupTimeoutError();
    const delayMs = Math.min(
      CONNECT_RETRY_BASE_MS * Math.max(1, attempt),
      CONNECT_RETRY_MAX_MS,
      remainingBeforeDelay,
    );
    await wait(delayMs, options.signal);

    throwIfAborted(options.signal);
    const connectBudgetMs = options.deadlineAt - Date.now();
    if (connectBudgetMs <= 0) throw new JsonWorkerStartupTimeoutError();
    attempt += 1;
    const socket = await options.workerRegistry.connect(
      options.sessionId,
      options.socketPath,
      connectBudgetMs,
    );
    if (options.signal.aborted) {
      socket?.destroy();
      options.workerRegistry.delete(options.sessionId);
      throwIfAborted(options.signal);
    }
    if (!socket) {
      if (!options.workerRegistry.hasProcess(options.sessionId)) {
        throw new Error("JSON worker exited before opening its control socket");
      }
      continue;
    }

    if (!options.workerRegistry.hasProcess(options.sessionId)) {
      socket.destroy();
      throw new Error("JSON worker exited before reporting ready");
    }

    const readyBudgetMs = options.deadlineAt - Date.now();
    if (readyBudgetMs <= 0) throw new JsonWorkerStartupTimeoutError();
    try {
      await options.workerRegistry.waitForReady(options.sessionId, readyBudgetMs);
    } catch (err) {
      if (Date.now() >= options.deadlineAt) throw new JsonWorkerStartupTimeoutError();
      throw err;
    }
    throwIfAborted(options.signal);
    if (!options.workerRegistry.has(options.sessionId)) {
      throw new Error("JSON worker disconnected after reporting ready");
    }
    return;
  }
}
