import { describe, expect, it } from "vitest";
import {
  int16PcmEnvelope,
  pcmWaveformDisplayValue,
  VOICE_WAVEFORM_FLOOR_DB,
} from "./pcm-waveform";

describe("int16PcmEnvelope", () => {
  it("preserves the minimum and maximum sample in each time bin", () => {
    const pcm = new Int16Array([-32768, -8192, 4096, 16384, -4096, 0, 8192, 32767]);

    expect(int16PcmEnvelope(new Uint8Array(pcm.buffer), 2)).toEqual([
      { min: -1, max: 0.5 },
      { min: -0.125, max: 32767 / 32768 },
    ]);
  });

  it("returns no bins for empty PCM", () => {
    expect(int16PcmEnvelope(new Uint8Array(), 8)).toEqual([]);
  });

  it("maps PCM amplitudes to a perceptual decibel display scale", () => {
    const halfwayAmplitude = 10 ** ((VOICE_WAVEFORM_FLOOR_DB / 2) / 20);
    const floorAmplitude = 10 ** (VOICE_WAVEFORM_FLOOR_DB / 20);

    expect(pcmWaveformDisplayValue(0)).toBe(0);
    expect(pcmWaveformDisplayValue(floorAmplitude)).toBeCloseTo(0);
    expect(pcmWaveformDisplayValue(halfwayAmplitude)).toBeCloseTo(0.5);
    expect(pcmWaveformDisplayValue(-halfwayAmplitude)).toBeCloseTo(-0.5);
    expect(pcmWaveformDisplayValue(1)).toBe(1);
  });
});
