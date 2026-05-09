import { afterEach, describe, expect, it, vi } from "vitest";
import { createPtyFrameWriteBuffer } from "./pty-frame-write-buffer";
import type { PtyRenderTarget } from "./pty-recovery";

function createTarget(): PtyRenderTarget & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    reset: vi.fn(() => calls.push(["reset", null])),
    resize: vi.fn((cols: number, rows: number) => calls.push(["resize", { cols, rows }])),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      calls.push(["write", data]);
      callback?.();
    }),
  };
}

describe("createPtyFrameWriteBuffer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes snapshots immediately but batches binary PTY frames to one animation frame", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const target = createTarget();
    const onFramePending = vi.fn();
    const onFrameWritten = vi.fn();
    const writer = createPtyFrameWriteBuffer(target, { onFramePending, onFrameWritten });
    const frame1 = new Uint8Array([65, 66]);
    const frame2 = new Uint8Array([67]);

    writer.target.write("snapshot");
    writer.target.write(frame1);
    writer.target.write(frame2);

    expect(target.calls).toEqual([["write", "snapshot"]]);
    expect(onFramePending).toHaveBeenCalledTimes(1);
    expect(onFrameWritten).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    queued[0]?.(16);

    expect(target.calls).toEqual([
      ["write", "snapshot"],
      ["write", new Uint8Array([65, 66, 67])],
    ]);
    expect(onFrameWritten).toHaveBeenCalledTimes(1);
  });

  it("holds binary frames while paused and flushes them when resumed", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const target = createTarget();
    const onFramePending = vi.fn();
    const onFrameWritten = vi.fn();
    const writer = createPtyFrameWriteBuffer(target, {
      paused: true,
      onFramePending,
      onFrameWritten,
    });

    writer.target.write(new Uint8Array([65]));
    writer.target.write(new Uint8Array([66]));

    expect(target.write).not.toHaveBeenCalled();
    expect(onFramePending).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    writer.setPaused(false);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    queued[0]?.(16);

    expect(target.calls).toEqual([["write", new Uint8Array([65, 66])]]);
    expect(onFrameWritten).toHaveBeenCalledTimes(1);
  });

  it("drops pending binary frames on dispose", () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const target = createTarget();
    const onFramePending = vi.fn();
    const onFrameWritten = vi.fn();
    const writer = createPtyFrameWriteBuffer(target, { onFramePending, onFrameWritten });

    writer.target.write(new Uint8Array([65]));
    writer.dispose();
    queued[0]?.(16);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(target.write).not.toHaveBeenCalled();
    expect(onFramePending).toHaveBeenCalledTimes(1);
    expect(onFrameWritten).not.toHaveBeenCalled();
  });
});
