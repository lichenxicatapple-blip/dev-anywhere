import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayReconnectLoop } from "./relay-reconnect-loop";

describe("Relay reconnect loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a failed preflight in the same page and stops after recovery", async () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValue(undefined);
    const loop = createRelayReconnectLoop(attempt);

    loop.start();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("cancels a pending retry when the page is disposed", async () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error("relay down"));
    const loop = createRelayReconnectLoop(attempt);

    loop.start();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("can restart after a pending retry was cancelled", async () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValue(undefined);
    const loop = createRelayReconnectLoop(attempt);

    loop.start();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    loop.stop();
    loop.start();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("times out a stuck preflight, aborts it, and retries", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const attempt = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>(() => undefined);
    });
    const loop = createRelayReconnectLoop(attempt, {
      attemptTimeoutMs: 5_000,
      initialDelayMs: 1_000,
    });

    loop.start();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);

    loop.stop();
    expect(signals[1]?.aborted).toBe(true);
  });
});
