import { describe, expect, it } from "vitest";
import { resampleMonoPcmS16le } from "./pcm-resample.js";

describe("resampleMonoPcmS16le", () => {
  it("converts 24 kHz PCM to 16 kHz while preserving duration", () => {
    const input = Buffer.alloc(240 * 2);
    for (let index = 0; index < 240; index += 1) {
      input.writeInt16LE(
        Math.round(Math.sin((2 * Math.PI * 1000 * index) / 24000) * 12000),
        index * 2,
      );
    }

    const output = resampleMonoPcmS16le(input, 24000, 16000);

    expect(output.byteLength).toBe(160 * 2);
    const samples = Array.from({ length: output.byteLength / 2 }, (_, index) =>
      output.readInt16LE(index * 2),
    );
    expect(Math.max(...samples)).toBeLessThanOrEqual(32767);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-32768);
    expect(samples.some((sample) => sample !== 0)).toBe(true);
  });

  it("rejects malformed PCM instead of silently dropping a byte", () => {
    expect(() => resampleMonoPcmS16le(Buffer.from([1]), 24000, 16000)).toThrow(
      "PCM 音频数据长度无效",
    );
  });
});
