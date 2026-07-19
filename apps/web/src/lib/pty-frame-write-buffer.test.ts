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

  // 模拟 transport.dispose 后 PtyRecoveryController.applySnapshot 的 deferred callback
  // 触发的 race：xterm 异步调 snapshot write callback，callback 内部 flushContiguousFrames
  // 调 frameWriter.target.write(Uint8Array)。此场景下不该泄漏到底层 target。
  it("blocks Uint8Array writes after dispose, preserving the dispose-then-callback race", () => {
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
    const writer = createPtyFrameWriteBuffer(target, {});

    // 1. 同步写 snapshot 字符串（dispose 之前），底层 target 立即拿到
    let capturedCallback: () => void = () => {};
    target.write = vi.fn((data, callback) => {
      target.calls.push(["write", data]);
      // 模拟 xterm 把 snapshot callback 推迟，dispose 之后才回调
      if (typeof data === "string") {
        if (callback) capturedCallback = callback;
      } else {
        callback?.();
      }
    });
    writer.target.write("snapshot", () => {});
    expect(target.calls).toEqual([["write", "snapshot"]]);

    // 2. 外部 transport 被 dispose
    writer.dispose();

    // 3. xterm 终于触发 snapshot 的 callback；模拟 PtyRecoveryController 在 callback 里
    // flushContiguousFrames 调 target.write(Uint8Array)
    capturedCallback();
    writer.target.write(new Uint8Array([65, 66]));

    // 关键断言：dispose 后只允许之前同步发出的 snapshot 字符串到达底层 target，
    // dispose 之后任何 Uint8Array 都不该泄漏（避免 xterm dispose 后再写入）。
    expect(target.calls).toEqual([["write", "snapshot"]]);
  });
});
