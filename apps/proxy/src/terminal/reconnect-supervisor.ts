import { setTimeout as sleep } from "node:timers/promises";

export type ReconnectAttemptResult = "connected" | "retry" | "stop";

export interface ReconnectRunRequest {
  attempt: (attempt: number) => Promise<ReconnectAttemptResult>;
  shouldStop: () => boolean;
}

export interface ReconnectRunHandle {
  started: boolean;
  completion: Promise<void>;
}

interface ReconnectSupervisorOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  wait?: (delayMs: number) => Promise<unknown>;
}

/**
 * Owns one reconnect loop for a runtime process.
 *
 * Socket close/error events can arrive more than once, including while a previous handshake is
 * still pending. Callers may request reconnection for every event; the supervisor folds them into
 * the current run and preserves one monotonic backoff sequence until it connects or stops.
 */
export class ReconnectSupervisor {
  private active: Promise<void> | null = null;
  private readonly wait: (delayMs: number) => Promise<unknown>;

  constructor(private readonly options: ReconnectSupervisorOptions) {
    if (options.initialDelayMs <= 0 || options.maxDelayMs < options.initialDelayMs) {
      throw new TypeError("Invalid reconnect backoff");
    }
    this.wait = options.wait ?? sleep;
  }

  request(request: ReconnectRunRequest): ReconnectRunHandle {
    if (this.active) {
      return { started: false, completion: this.active };
    }

    const completion = this.run(request);
    this.active = completion;
    const clear = (): void => {
      if (this.active === completion) this.active = null;
    };
    void completion.then(clear, clear);
    return { started: true, completion };
  }

  private async run(request: ReconnectRunRequest): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      if (request.shouldStop()) return;
      const delayMs = Math.min(this.options.initialDelayMs * attempt, this.options.maxDelayMs);
      await this.wait(delayMs);
      // Stop may be requested while the timer is pending. Do not perform one final connection
      // attempt after a terminal process has already begun shutting down.
      if (request.shouldStop()) return;

      const result = await request.attempt(attempt);
      if (result !== "retry") return;
    }
  }
}
