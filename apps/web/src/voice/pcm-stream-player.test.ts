import { describe, expect, it } from "vitest";
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
});
