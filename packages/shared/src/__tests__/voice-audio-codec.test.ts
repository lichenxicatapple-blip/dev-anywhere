import { describe, expect, it } from "vitest";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw } from "../voice-audio-codec";

function pcmBytes(samples: number[]): Uint8Array {
  const values = Int16Array.from(samples);
  return new Uint8Array(values.buffer);
}

describe("G.711 mu-law codec", () => {
  it("uses the standard zero and full-scale code points", () => {
    expect(Array.from(encodePcm16ToMuLaw(pcmBytes([0, 32767, -32768])))).toEqual([
      0xff, 0x80, 0x00,
    ]);
  });

  it("round-trips speech-range PCM with bounded companding error", () => {
    const source = [-12000, -4000, -500, 0, 500, 4000, 12000];
    const decoded = new Int16Array(decodeMuLawToPcm16(encodePcm16ToMuLaw(pcmBytes(source))).buffer);

    decoded.forEach((sample, index) => {
      const expected = source[index] ?? 0;
      expect(Math.abs(sample - expected)).toBeLessThan(Math.max(40, Math.abs(expected) * 0.04));
    });
  });
});
