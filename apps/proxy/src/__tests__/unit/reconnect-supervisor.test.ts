import { describe, expect, it, vi } from "vitest";
import { ReconnectSupervisor } from "#src/terminal/reconnect-supervisor.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReconnectSupervisor", () => {
  it("folds concurrent reconnect requests into one active run", async () => {
    const timer = deferred();
    const attempt = vi.fn(async () => "connected" as const);
    const supervisor = new ReconnectSupervisor({
      initialDelayMs: 1,
      maxDelayMs: 5,
      wait: () => timer.promise,
    });

    const first = supervisor.request({ attempt, shouldStop: () => false });
    const followers = Array.from({ length: 10_000 }, () =>
      supervisor.request({ attempt, shouldStop: () => false }),
    );

    expect(first.started).toBe(true);
    expect(followers.every((run) => !run.started)).toBe(true);
    expect(followers.every((run) => run.completion === first.completion)).toBe(true);

    timer.resolve();
    await first.completion;
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("keeps one monotonic capped backoff sequence across failed attempts", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const supervisor = new ReconnectSupervisor({
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    const run = supervisor.request({
      shouldStop: () => false,
      attempt: async () => (++attempts === 6 ? "connected" : "retry"),
    });

    await run.completion;
    expect(attempts).toBe(6);
    expect(delays).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 5_000]);
  });

  it("does not make a final attempt when shutdown happens during backoff", async () => {
    const timer = deferred();
    let stopped = false;
    const attempt = vi.fn(async () => "connected" as const);
    const supervisor = new ReconnectSupervisor({
      initialDelayMs: 1,
      maxDelayMs: 5,
      wait: () => timer.promise,
    });

    const run = supervisor.request({ attempt, shouldStop: () => stopped });
    stopped = true;
    timer.resolve();

    await run.completion;
    expect(attempt).not.toHaveBeenCalled();
  });

  it("allows a fresh run after the previous run settles", async () => {
    const supervisor = new ReconnectSupervisor({
      initialDelayMs: 1,
      maxDelayMs: 5,
      wait: async () => {},
    });
    const attempt = vi.fn(async () => "connected" as const);

    await supervisor.request({ attempt, shouldStop: () => false }).completion;
    const next = supervisor.request({ attempt, shouldStop: () => false });
    await next.completion;

    expect(next.started).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
