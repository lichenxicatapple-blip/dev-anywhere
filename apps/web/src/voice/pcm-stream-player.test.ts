import { afterEach, describe, expect, it, vi } from "vitest";
import { int16PcmToFloat32 } from "./pcm-stream-player";

describe("int16PcmToFloat32", () => {
  it("converts little-endian PCM into normalized float samples", () => {
    const source = new Int16Array([-32768, 0, 16384, 32767]);
    expect(Array.from(int16PcmToFloat32(new Uint8Array(source.buffer)))).toEqual([
      -1,
      0,
      0.5,
      32767 / 32768,
    ]);
  });
});

describe("PcmStreamPlayer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes a suspended AudioContext before scheduling playback", async () => {
    const { PcmStreamPlayer } = await import("./pcm-stream-player");
    const resume = vi.fn().mockResolvedValue(undefined);
    const context = {
      state: "suspended",
      currentTime: 0,
      destination: {},
      resume,
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData() {
            return data;
          },
        };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start() {},
        };
      },
    } as unknown as AudioContext;
    const player = new PcmStreamPlayer(context, 1000);

    player.enqueue(new Uint8Array(200));

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("returns the queued playback time including already scheduled audio", async () => {
    const { PcmStreamPlayer } = await import("./pcm-stream-player");
    const starts: number[] = [];
    const context = {
      currentTime: 10,
      destination: {},
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData() {
            return data;
          },
        };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start(value: number) {
            starts.push(value);
          },
        };
      },
    } as unknown as AudioContext;
    const player = new PcmStreamPlayer(context, 1000);

    expect(player.enqueue(new Uint8Array(200))).toBeCloseTo(100);
    expect(player.enqueue(new Uint8Array(100))).toBeCloseTo(150);
    expect(starts).toEqual([10, 10.1]);
  });

  it("reports activity on the scheduled playback timeline", async () => {
    vi.useFakeTimers();
    const { PcmStreamPlayer } = await import("./pcm-stream-player");
    const activity: number[] = [];
    const context = {
      currentTime: 10,
      destination: {},
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData() {
            return data;
          },
        };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start() {},
        };
      },
    } as unknown as AudioContext;
    const player = new PcmStreamPlayer(context, 1000, {
      onActivityLevel: (level) => activity.push(level),
    });
    const source = new Int16Array([16384, 16384, 16384, 16384]);

    player.enqueue(new Uint8Array(source.buffer));
    expect(activity).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(activity.at(-1)).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(4);
    expect(activity.at(-1)).toBe(0);
  });

  it("does not clear activity between contiguous scheduled chunks", async () => {
    vi.useFakeTimers();
    const { PcmStreamPlayer } = await import("./pcm-stream-player");
    const activity: number[] = [];
    const context = {
      currentTime: 10,
      destination: {},
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData() {
            return data;
          },
        };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start() {},
        };
      },
    } as unknown as AudioContext;
    const player = new PcmStreamPlayer(context, 1000, {
      onActivityLevel: (level) => activity.push(level),
    });
    const loud = new Uint8Array(new Int16Array([16384, 16384]).buffer);
    const quiet = new Uint8Array(new Int16Array([8192, 8192]).buffer);

    player.enqueue(loud);
    player.enqueue(quiet);

    await vi.advanceTimersByTimeAsync(0);
    expect(activity.at(-1)).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(activity.at(-1)).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(activity.at(-1)).toBe(0);
  });
});
