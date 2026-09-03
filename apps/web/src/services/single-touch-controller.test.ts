import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SingleTouchController,
  type SingleTouchControllerOptions,
} from "./single-touch-controller";

type TouchInput = Parameters<SingleTouchControllerOptions["send"]>[0];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<SingleTouchControllerOptions> = {}) {
  let now = 0;
  const send = vi.fn<SingleTouchControllerOptions["send"]>().mockResolvedValue(undefined);
  const onFailure = vi.fn();
  const controller = new SingleTouchController({
    send,
    onFailure,
    now: () => now,
    ...overrides,
  });
  return {
    controller,
    send,
    onFailure,
    setNow(value: number) {
      now = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SingleTouchController", () => {
  it("sends a click as immediate down followed by up", () => {
    const { controller, send } = fixture();

    expect(controller.begin(1, { x: 0.1, y: 0.2 })).toBe(true);
    expect(send).toHaveBeenCalledWith({ kind: "touch", phase: "down", x: 0.1, y: 0.2 });
    expect(controller.end(1, { x: 0.1, y: 0.2 })).toBe(true);

    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "touch", phase: "down", x: 0.1, y: 0.2 },
      { kind: "touch", phase: "up", x: 0.1, y: 0.2 },
    ]);
  });

  it("keeps a long press down until it is explicitly ended", async () => {
    vi.useFakeTimers();
    const { controller, send } = fixture();

    controller.begin(1, { x: 0.2, y: 0.3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(1);

    controller.end(1, { x: 0.2, y: 0.3 });
    expect(send.mock.calls.map(([input]) => input.phase)).toEqual(["down", "up"]);
  });

  it("streams a drag through the phased single-touch path", () => {
    const { controller, send, setNow } = fixture();

    controller.begin(7, { x: 0.1, y: 0.2 });
    setNow(20);
    controller.move(7, { x: 0.3, y: 0.4 });
    setNow(40);
    controller.move(7, { x: 0.5, y: 0.6 });
    controller.end(7, { x: 0.7, y: 0.8 });

    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "touch", phase: "down", x: 0.1, y: 0.2 },
      { kind: "touch", phase: "move", x: 0.3, y: 0.4 },
      { kind: "touch", phase: "move", x: 0.5, y: 0.6 },
      { kind: "touch", phase: "up", x: 0.7, y: 0.8 },
    ]);
  });

  it("flushes the last move received inside a 16 ms window", async () => {
    vi.useFakeTimers();
    const { controller, send, setNow } = fixture();

    controller.begin(1, { x: 0, y: 0 });
    setNow(100);
    controller.move(1, { x: 0.1, y: 0.1 });
    setNow(105);
    controller.move(1, { x: 0.2, y: 0.2 });
    setNow(110);
    controller.move(1, { x: 0.3, y: 0.3 });

    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "touch", phase: "down", x: 0, y: 0 },
      { kind: "touch", phase: "move", x: 0.1, y: 0.1 },
    ]);
    setNow(116);
    await vi.advanceTimersByTimeAsync(16);
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      kind: "touch",
      phase: "move",
      x: 0.3,
      y: 0.3,
    });
  });

  it("does not let an earlier move acknowledgement bypass the active frame window", async () => {
    vi.useFakeTimers();
    const firstMove = deferred<void>();
    const send = vi.fn((input: TouchInput) =>
      input.phase === "move" ? firstMove.promise : Promise.resolve(),
    );
    const { controller, setNow } = fixture({ send, maxInFlightMoves: 1 });

    controller.begin(1, { x: 0, y: 0 });
    setNow(100);
    controller.move(1, { x: 0.1, y: 0.1 });
    setNow(105);
    controller.move(1, { x: 0.2, y: 0.2 });
    firstMove.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(2);
    setNow(116);
    await vi.advanceTimersByTimeAsync(16);
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      kind: "touch",
      phase: "move",
      x: 0.2,
      y: 0.2,
    });
  });

  it("keeps only the latest move while all in-flight slots are saturated", async () => {
    const moves: Array<ReturnType<typeof deferred<void>>> = [];
    const send = vi.fn(async (input: TouchInput) => {
      if (input.phase !== "move") return;
      const request = deferred<void>();
      moves.push(request);
      return request.promise;
    });
    const { controller, setNow } = fixture({ send });
    controller.begin(1, { x: 0, y: 0 });

    for (let index = 1; index <= 20; index += 1) {
      setNow(index * 20);
      controller.move(1, { x: index / 100, y: index / 100 });
    }
    expect(moves).toHaveLength(16);

    moves[0]?.resolve();
    await vi.waitFor(() => expect(moves).toHaveLength(17));
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      kind: "touch",
      phase: "move",
      x: 0.2,
      y: 0.2,
    });
  });

  it("cancels once at the last point and ignores a repeated cancellation", () => {
    const { controller, send, setNow } = fixture();
    controller.begin(1, { x: 0.1, y: 0.2 });
    setNow(20);
    controller.move(1, { x: 0.4, y: 0.5 });

    expect(controller.cancel(1)).toBe(true);
    expect(controller.cancel(1)).toBe(false);
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      kind: "touch",
      phase: "up",
      x: 0.4,
      y: 0.5,
    });
  });

  it("ignores a second pointer while the first pointer is active", () => {
    const { controller, send } = fixture();
    expect(controller.begin(1, { x: 0.1, y: 0.2 })).toBe(true);
    expect(controller.begin(2, { x: 0.8, y: 0.9 })).toBe(false);
    expect(controller.move(2, { x: 0.7, y: 0.7 })).toBe(false);
    expect(controller.end(2, { x: 0.7, y: 0.7 })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("best-effort releases an active touch when disposed", async () => {
    const release = deferred<void>();
    const send = vi.fn((input: TouchInput) =>
      input.phase === "up" ? release.promise : Promise.resolve(),
    );
    const { controller, onFailure } = fixture({ send });
    controller.begin(1, { x: 0.3, y: 0.4 });

    controller.dispose();
    controller.dispose();
    release.reject(new Error("old access closed"));
    await Promise.resolve();

    expect(send.mock.calls.map(([input]) => input.phase)).toEqual(["down", "up"]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("ignores a late failed acknowledgement from a disposed access generation", async () => {
    const oldMove = deferred<void>();
    const oldFailure = vi.fn();
    const oldController = new SingleTouchController({
      send: (input) => (input.phase === "move" ? oldMove.promise : Promise.resolve()),
      onFailure: oldFailure,
      now: () => 20,
    });
    const nextFailure = vi.fn();
    const nextController = new SingleTouchController({
      send: async () => {},
      onFailure: nextFailure,
    });
    oldController.begin(1, { x: 0, y: 0 });
    oldController.move(1, { x: 0.1, y: 0.1 });
    oldController.dispose();
    nextController.begin(2, { x: 0.2, y: 0.2 });

    oldMove.reject(new Error("late old failure"));
    await Promise.resolve();

    expect(oldFailure).not.toHaveBeenCalled();
    expect(nextFailure).not.toHaveBeenCalled();
  });

  it.each(["down", "move", "up"] as const)(
    "fails the access exactly once when %s is rejected",
    async (failedPhase) => {
      const requests = new Map<TouchInput["phase"], ReturnType<typeof deferred<void>>>();
      const send = vi.fn((input: TouchInput) => {
        const request = deferred<void>();
        requests.set(input.phase, request);
        return request.promise;
      });
      const { controller, onFailure, setNow } = fixture({ send });
      controller.begin(1, { x: 0.1, y: 0.1 });
      if (failedPhase !== "down") {
        requests.get("down")?.resolve();
        await Promise.resolve();
      }
      if (failedPhase === "move") {
        setNow(20);
        controller.move(1, { x: 0.2, y: 0.2 });
      }
      if (failedPhase === "up") controller.end(1, { x: 0.3, y: 0.3 });

      const failure = new Error(`${failedPhase} failed`);
      requests.get(failedPhase)?.reject(failure);
      await Promise.resolve();
      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith(failure);

      for (const request of requests.values()) request.reject(new Error("concurrent failure"));
      await Promise.resolve();
      expect(onFailure).toHaveBeenCalledOnce();
      expect(controller.begin(2, { x: 0.4, y: 0.4 })).toBe(false);
    },
  );
});
