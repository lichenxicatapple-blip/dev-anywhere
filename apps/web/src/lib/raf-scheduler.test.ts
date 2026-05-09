import { afterEach, describe, expect, it, vi } from "vitest";
import { createRafScheduler } from "./raf-scheduler";

describe("createRafScheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces repeated schedules into one animation frame callback", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const callback = vi.fn();
    const scheduler = createRafScheduler(callback);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    queued[0]?.(16);

    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.schedule();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work on dispose", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const callback = vi.fn();
    const scheduler = createRafScheduler(callback);

    scheduler.schedule();
    scheduler.dispose();
    queued[0]?.(16);
    scheduler.schedule();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(callback).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
