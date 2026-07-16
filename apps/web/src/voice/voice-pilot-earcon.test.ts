import { describe, expect, it } from "vitest";
import { createVoicePilotEarcon } from "./voice-pilot-earcon";

const SAMPLE_RATE = 24000;

function pcmSamples(pcm: Uint8Array): Int16Array {
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / Int16Array.BYTES_PER_ELEMENT);
}

function signalEnergy(pcm: Uint8Array): number {
  let energy = 0;
  for (const sample of pcmSamples(pcm)) energy += sample * sample;
  return energy;
}

function zeroCrossings(samples: Int16Array, start: number, end: number): number {
  let crossings = 0;
  let previousSign = 0;
  for (let index = start; index < end; index += 1) {
    const sample = samples[index] ?? 0;
    const sign = sample === 0 ? previousSign : Math.sign(sample);
    if (previousSign !== 0 && sign !== previousSign) crossings += 1;
    previousSign = sign;
  }
  return crossings;
}

function cueDirection(pcm: Uint8Array): number {
  const samples = pcmSamples(pcm);
  const windowLength = Math.floor(samples.length * 0.4);
  const first = zeroCrossings(samples, 0, windowLength);
  const last = zeroCrossings(samples, samples.length - windowLength, samples.length);
  return last - first;
}

describe("createVoicePilotEarcon", () => {
  it("gives listening start and end exactly the same duration and signal energy", () => {
    const start = createVoicePilotEarcon("listening-start", SAMPLE_RATE);
    const end = createVoicePilotEarcon("user-end", SAMPLE_RATE);

    expect(start.durationMs).toBe(end.durationMs);
    expect(start.pcm.byteLength).toBe(end.pcm.byteLength);
    expect(signalEnergy(start.pcm)).toBe(signalEnergy(end.pcm));
  });

  it("uses an ascending cue for listening start and a descending cue for listening end", () => {
    const start = createVoicePilotEarcon("listening-start", SAMPLE_RATE);
    const end = createVoicePilotEarcon("user-end", SAMPLE_RATE);

    expect(cueDirection(start.pcm)).toBeGreaterThan(0);
    expect(cueDirection(end.pcm)).toBeLessThan(0);
  });

  it("keeps every cue within signed 16-bit PCM range", () => {
    for (const kind of ["listening-start", "user-end", "assistant-end"] as const) {
      const samples = pcmSamples(createVoicePilotEarcon(kind, SAMPLE_RATE).pcm);
      expect(Math.max(...samples)).toBeLessThanOrEqual(32767);
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(-32768);
    }
  });
});
