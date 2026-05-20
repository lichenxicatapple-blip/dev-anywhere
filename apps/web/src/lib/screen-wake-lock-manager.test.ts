import { describe, expect, it, vi } from "vitest";
import { ScreenWakeLockManager, type WakeLockSentinelLike } from "./screen-wake-lock-manager";

class FakeSentinel extends EventTarget implements WakeLockSentinelLike {
  released = false;
  release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

describe("ScreenWakeLockManager", () => {
  it("keeps the browser wake lock while any scope remains active", async () => {
    const sentinels = [new FakeSentinel()];
    const request = vi.fn(async () => sentinels.shift()!);
    const manager = new ScreenWakeLockManager({ request, document: new FakeDocument() });

    await manager.enable("chat:s1");
    await manager.enable("voice-pilot:s1");

    expect(request).toHaveBeenCalledTimes(1);
    await manager.disable("voice-pilot:s1");
    expect(request.mock.results[0]?.value).toBeDefined();
    expect(manager.getSnapshot("chat:s1").active).toBe(true);
    expect(manager.getSnapshot("voice-pilot:s1").active).toBe(false);
    expect((await request.mock.results[0]!.value).release).not.toHaveBeenCalled();

    await manager.disable("chat:s1");
    expect((await request.mock.results[0]!.value).release).toHaveBeenCalledTimes(1);
  });

  it("releases the sentinel on background but keeps desired scopes for foreground reacquire", async () => {
    const doc = new FakeDocument();
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    const request = vi.fn(async () => (request.mock.calls.length === 1 ? first : second));
    const manager = new ScreenWakeLockManager({ request, document: doc });

    await manager.enable("voice-pilot:s1");
    expect(request).toHaveBeenCalledTimes(1);

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot("voice-pilot:s1").active).toBe(true);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot("voice-pilot:s1").active).toBe(true);
  });

  it("does not reacquire after the last scope is disabled while backgrounded", async () => {
    const doc = new FakeDocument();
    const request = vi.fn(async () => new FakeSentinel());
    const manager = new ScreenWakeLockManager({ request, document: doc });

    await manager.enable("voice-pilot:s1");
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await manager.disable("voice-pilot:s1");

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot("voice-pilot:s1").active).toBe(false);
  });

  it("releases a wake lock request that resolves after its scope was disabled", async () => {
    let resolveRequest!: (sentinel: FakeSentinel) => void;
    const request = vi.fn(
      () =>
        new Promise<FakeSentinel>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const manager = new ScreenWakeLockManager({ request, document: new FakeDocument() });

    const enablePromise = manager.enable("chat:s1").catch(() => undefined);
    expect(manager.getSnapshot("chat:s1").pending).toBe(true);

    await manager.disable("chat:s1");
    const sentinel = new FakeSentinel();
    resolveRequest(sentinel);
    await enablePromise;

    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot("chat:s1").active).toBe(false);
  });
});
