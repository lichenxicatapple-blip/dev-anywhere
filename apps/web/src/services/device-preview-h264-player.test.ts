import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JMuxerFeedData, JMuxerOptions } from "jmuxer";

interface MockJMuxerInstance {
  options: JMuxerOptions;
  feed: ReturnType<typeof vi.fn<(data: JMuxerFeedData) => void>>;
  reset: ReturnType<typeof vi.fn<() => void>>;
  destroy: ReturnType<typeof vi.fn<() => void>>;
}

const jmuxerMock = vi.hoisted(() => ({ instances: [] as MockJMuxerInstance[] }));

vi.mock("jmuxer", () => ({
  default: class MockJMuxer implements MockJMuxerInstance {
    readonly feed = vi.fn<(data: JMuxerFeedData) => void>();
    readonly reset = vi.fn<() => void>();
    readonly destroy = vi.fn<() => void>();

    constructor(readonly options: JMuxerOptions) {
      jmuxerMock.instances.push(this);
    }
  },
}));

import { DevicePreviewH264Player } from "./device-preview-h264-player";

async function latestMuxer(): Promise<MockJMuxerInstance> {
  await vi.waitFor(() => expect(jmuxerMock.instances).toHaveLength(1));
  const instance = jmuxerMock.instances.at(-1);
  if (!instance) throw new Error("JMuxer was not constructed");
  return instance;
}

function createVideo(): {
  video: HTMLVideoElement;
  play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
  load: ReturnType<typeof vi.fn<() => void>>;
} {
  const video = document.createElement("video");
  video.disableRemotePlayback = false;
  const play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pause = vi.fn<() => void>();
  const load = vi.fn<() => void>();
  Object.defineProperties(video, {
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
    load: { configurable: true, value: load },
  });
  return { video, play, pause, load };
}

function signalReady(instance: MockJMuxerInstance, isReset = false): void {
  instance.options.onReady?.(isReset, {} as MediaSource);
}

describe("DevicePreviewH264Player", () => {
  beforeEach(() => {
    jmuxerMock.instances.length = 0;
  });

  it("configures JMuxer for immediate low-latency video playback", async () => {
    const { video } = createVideo();
    const player = new DevicePreviewH264Player(video);

    expect((await latestMuxer()).options).toMatchObject({
      node: video,
      mode: "video",
      flushingTime: 0,
      maxDelay: 150,
      clearBuffer: true,
    });
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.disableRemotePlayback).toBe(true);

    player.destroy();
  });

  it("bounds live playback delay without waiting for JMuxer's one-second fallback", async () => {
    const { video } = createVideo();
    let mediaTime = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => mediaTime,
      set: (value: number) => {
        mediaTime = value;
      },
    });
    Object.defineProperty(video, "buffered", {
      configurable: true,
      value: {
        length: 1,
        start: () => 0,
        end: () => 1,
      } satisfies TimeRanges,
    });
    const player = new DevicePreviewH264Player(video);
    const muxer = await latestMuxer();
    vi.useFakeTimers();
    try {
      signalReady(muxer);

      await vi.advanceTimersByTimeAsync(99);
      expect(mediaTime).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(mediaTime).toBeCloseTo(0.999, 6);

      player.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      player.destroy();
      vi.useRealTimers();
    }
  });

  it("waits for MSE readiness and starts each decoder generation at a keyframe", async () => {
    const { video, play } = createVideo();
    const onStart = vi.fn();
    const player = new DevicePreviewH264Player(video, { onStart });
    const configuration = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2]);
    const keyframe = Uint8Array.from([0, 0, 0, 1, 0x65, 3]);
    const deltaFrame = Uint8Array.from([0, 0, 0, 1, 0x41, 4]);

    player.feed({ kind: "configuration", keyframe: false, durationMs: 0, data: configuration });
    player.feed({ kind: "frame", keyframe: false, durationMs: 17, data: deltaFrame });
    player.feed({ kind: "frame", keyframe: true, durationMs: 34, data: keyframe });
    player.feed({ kind: "frame", keyframe: false, durationMs: 33, data: deltaFrame });

    const muxer = await latestMuxer();
    expect(muxer.feed).not.toHaveBeenCalled();
    signalReady(muxer);

    expect(muxer.feed).toHaveBeenCalledTimes(3);
    expect(muxer.feed).toHaveBeenNthCalledWith(1, {
      video: configuration,
      duration: 0,
      isLastVideoFrameComplete: true,
    });
    expect(muxer.feed).toHaveBeenNthCalledWith(2, {
      video: keyframe,
      duration: 34,
      isLastVideoFrameComplete: true,
    });
    expect(muxer.feed).toHaveBeenNthCalledWith(3, {
      video: deltaFrame,
      duration: 33,
      isLastVideoFrameComplete: true,
    });
    expect(play).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    player.feed({ kind: "frame", keyframe: false, durationMs: 33, data: deltaFrame });
    expect(play).toHaveBeenCalledOnce();

    video.dispatchEvent(new Event("playing"));
    expect(onStart).toHaveBeenCalledOnce();
    player.destroy();
  });

  it("resets only when an already-applied SPS/PPS configuration changes", async () => {
    const { video, play } = createVideo();
    const player = new DevicePreviewH264Player(video);
    const muxer = await latestMuxer();
    const firstConfiguration = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2]);
    const nextConfiguration = Uint8Array.from([0, 0, 0, 1, 0x67, 9, 0, 0, 0, 1, 0x68, 8]);
    const keyframe = Uint8Array.from([0, 0, 0, 1, 0x65, 3]);
    const deltaFrame = Uint8Array.from([0, 0, 0, 1, 0x41, 4]);

    signalReady(muxer);
    player.feed({
      kind: "configuration",
      keyframe: false,
      durationMs: 0,
      data: firstConfiguration,
    });
    player.feed({ kind: "frame", keyframe: true, durationMs: 33, data: keyframe });
    muxer.feed.mockClear();

    player.feed({
      kind: "configuration",
      keyframe: false,
      durationMs: 0,
      data: firstConfiguration,
    });
    expect(muxer.reset).not.toHaveBeenCalled();
    expect(muxer.feed).not.toHaveBeenCalled();

    player.feed({
      kind: "configuration",
      keyframe: false,
      durationMs: 0,
      data: nextConfiguration,
    });
    player.feed({ kind: "frame", keyframe: false, durationMs: 33, data: deltaFrame });
    expect(muxer.reset).toHaveBeenCalledOnce();
    expect(muxer.feed).not.toHaveBeenCalled();

    signalReady(muxer, true);
    player.feed({ kind: "frame", keyframe: true, durationMs: 40, data: keyframe });
    expect(muxer.feed).toHaveBeenNthCalledWith(1, {
      video: nextConfiguration,
      duration: 0,
      isLastVideoFrameComplete: true,
    });
    expect(muxer.feed).toHaveBeenNthCalledWith(2, {
      video: keyframe,
      duration: 40,
      isLastVideoFrameComplete: true,
    });
    expect(play).toHaveBeenCalledTimes(2);

    player.destroy();
  });

  it("reports muxer, codec, and autoplay failures", async () => {
    const { video, play } = createVideo();
    const onError = vi.fn();
    const player = new DevicePreviewH264Player(video, { onError });
    const muxer = await latestMuxer();

    muxer.options.onError?.({ name: "QuotaExceededError", error: "buffer full" });
    muxer.options.onUnsupportedCodec?.("avc1.640032");
    expect(onError.mock.calls.map((call) => (call[0] as Error).message)).toEqual([
      "QuotaExceededError: buffer full",
      "Browser does not support the H.264 codec avc1.640032",
    ]);

    play.mockRejectedValueOnce(new Error("play() requires a user gesture"));
    signalReady(muxer);
    player.feed({
      kind: "configuration",
      keyframe: false,
      durationMs: 0,
      data: Uint8Array.from([0, 0, 0, 1, 0x67, 1]),
    });
    player.feed({
      kind: "frame",
      keyframe: true,
      durationMs: 33,
      data: Uint8Array.from([0, 0, 0, 1, 0x65, 2]),
    });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "play() requires a user gesture" }),
      ),
    );

    player.destroy();
  });

  it("requests one resync and resets the decoder when the bounded buffer overflows", async () => {
    const { video } = createVideo();
    const onResyncRequired = vi.fn();
    const player = new DevicePreviewH264Player(video, {
      onResyncRequired,
      maxBufferedPackets: 2,
    });
    const muxer = await latestMuxer();
    signalReady(muxer);

    player.feed({
      kind: "configuration",
      keyframe: false,
      durationMs: 0,
      data: Uint8Array.from([0, 0, 0, 1, 0x67, 1]),
    });
    player.feed({
      kind: "frame",
      keyframe: true,
      durationMs: 33,
      data: Uint8Array.from([0, 0, 0, 1, 0x65, 2]),
    });
    player.feed({
      kind: "frame",
      keyframe: false,
      durationMs: 33,
      data: Uint8Array.from([0, 0, 0, 1, 0x41, 3]),
    });

    expect(muxer.reset).toHaveBeenCalledOnce();
    expect(onResyncRequired).toHaveBeenCalledOnce();
    expect(onResyncRequired).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("reconnecting") }),
    );

    player.feed({
      kind: "frame",
      keyframe: false,
      durationMs: 33,
      data: Uint8Array.from([0, 0, 0, 1, 0x41, 4]),
    });
    expect(muxer.reset).toHaveBeenCalledOnce();
    expect(onResyncRequired).toHaveBeenCalledOnce();

    player.destroy();
  });

  it("fully detaches JMuxer media state and ignores callbacks after destroy", async () => {
    const { video, pause, load } = createVideo();
    video.setAttribute("src", "/original.mp4");
    const originalSrcObject = {} as MediaStream;
    video.srcObject = originalSrcObject;
    const originalSource = document.createElement("source");
    originalSource.src = "/original-fallback.mp4";
    video.append(originalSource);
    const onStart = vi.fn();
    const onError = vi.fn();
    const player = new DevicePreviewH264Player(video, { onStart, onError });
    const muxer = await latestMuxer();
    const generatedSource = document.createElement("source");
    generatedSource.src = "blob:jmuxer-managed-source";
    video.append(generatedSource);
    video.setAttribute("src", "blob:jmuxer-media-source");
    const revokeObjectURL = vi.fn();
    const previousRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      player.destroy();
      player.destroy();

      expect(muxer.destroy).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledOnce();
      expect(video.getAttribute("src")).toBe("/original.mp4");
      expect(video.srcObject).toBe(originalSrcObject);
      expect(video.querySelectorAll("source")).toHaveLength(1);
      expect(video.querySelector("source")).toBe(originalSource);
      expect(video.autoplay).toBe(false);
      expect(video.disableRemotePlayback).toBe(false);
      expect(video.muted).toBe(false);
      expect(video.playsInline).toBe(false);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:jmuxer-media-source");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:jmuxer-managed-source");

      muxer.options.onError?.({ name: "late error" });
      muxer.options.onUnsupportedCodec?.("late codec");
      video.dispatchEvent(new Event("playing"));
      expect(onError).not.toHaveBeenCalled();
      expect(onStart).not.toHaveBeenCalled();
    } finally {
      if (previousRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: previousRevokeObjectURL,
        });
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });
});
