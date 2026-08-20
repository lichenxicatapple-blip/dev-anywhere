import { describe, expect, it, vi } from "vitest";
import { createPtyTransportAttachScheduler } from "./pty-transport-attach-scheduler";

function createHarness() {
  let nextHandle = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const scheduler = createPtyTransportAttachScheduler({
    schedule: (callback) => {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel: (handle) => callbacks.delete(handle),
  });
  const flushFrame = (): void => {
    const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) return;
    callbacks.delete(next[0]);
    next[1](performance.now());
  };
  return { callbacks, flushFrame, scheduler };
}

describe("createPtyTransportAttachScheduler", () => {
  it("attaches the active PTY immediately and admits one background PTY per frame", () => {
    const h = createHarness();
    const calls: string[] = [];

    h.scheduler.enqueue("hidden-1", "background", () => calls.push("hidden-1"));
    h.scheduler.enqueue("hidden-2", "background", () => calls.push("hidden-2"));
    h.scheduler.enqueue("active", "active", () => calls.push("active"));

    expect(calls).toEqual(["active"]);
    expect(h.callbacks.size).toBe(1);
    h.flushFrame();
    expect(calls).toEqual(["active", "hidden-1"]);
    expect(h.callbacks.size).toBe(1);
    h.flushFrame();
    expect(calls).toEqual(["active", "hidden-1", "hidden-2"]);
  });

  it("promotes a queued PTY without running its stale background task", () => {
    const h = createHarness();
    const background = vi.fn();
    const active = vi.fn();

    h.scheduler.enqueue("session", "background", background);
    h.scheduler.enqueue("session", "active", active);
    h.flushFrame();

    expect(active).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();
  });

  it("cancels an individual queued attach and clears the queue on dispose", () => {
    const h = createHarness();
    const first = vi.fn();
    const second = vi.fn();

    const cancelFirst = h.scheduler.enqueue("first", "background", first);
    h.scheduler.enqueue("second", "background", second);
    cancelFirst();
    h.scheduler.dispose();
    h.flushFrame();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
  });
});
