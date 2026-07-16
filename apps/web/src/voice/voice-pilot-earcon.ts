export type VoicePilotEarcon = "listening-start" | "user-end" | "assistant-end";

export interface VoicePilotEarconPcm {
  pcm: Uint8Array;
  durationMs: number;
}

interface ToneSpec {
  frequency: number;
  durationMs: number;
  gain: number;
}

const LISTENING_BOUNDARY_FREQUENCIES = [784, 1047] as const;
const LISTENING_BOUNDARY_NOTE_MS = 70;
const LISTENING_BOUNDARY_GAP_MS = 20;
const LISTENING_BOUNDARY_GAIN = 0.16;
const TONE_FADE_MS = 6;

const ASSISTANT_END_TONE: ToneSpec = {
  frequency: 660,
  durationMs: 110,
  gain: 0.09,
};

function createTonePcm(sampleRate: number, spec: ToneSpec): Uint8Array {
  const sampleCount = Math.max(1, Math.ceil((sampleRate * spec.durationMs) / 1000));
  const fadeSamples = Math.max(1, Math.floor((sampleRate * TONE_FADE_MS) / 1000));
  const samples = new Int16Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const attack = Math.min(1, index / fadeSamples);
    const release = Math.min(1, (sampleCount - index - 1) / fadeSamples);
    const envelope = Math.max(0, Math.min(attack, release));
    const wave = Math.sin((2 * Math.PI * spec.frequency * index) / sampleRate);
    samples[index] = Math.round(wave * envelope * spec.gain * 32767);
  }

  return new Uint8Array(samples.buffer);
}

function createSilencePcm(sampleRate: number, durationMs: number): Uint8Array {
  const sampleCount = Math.max(0, Math.ceil((sampleRate * durationMs) / 1000));
  return new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
}

function concatPcm(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createListeningBoundaryPcm(
  kind: "listening-start" | "user-end",
  sampleRate: number,
): Uint8Array {
  const frequencies =
    kind === "listening-start"
      ? LISTENING_BOUNDARY_FREQUENCIES
      : [...LISTENING_BOUNDARY_FREQUENCIES].reverse();
  const tones = frequencies.map((frequency) =>
    createTonePcm(sampleRate, {
      frequency,
      durationMs: LISTENING_BOUNDARY_NOTE_MS,
      gain: LISTENING_BOUNDARY_GAIN,
    }),
  );

  return concatPcm([
    tones[0] ?? new Uint8Array(),
    createSilencePcm(sampleRate, LISTENING_BOUNDARY_GAP_MS),
    tones[1] ?? new Uint8Array(),
  ]);
}

export function createVoicePilotEarcon(
  kind: VoicePilotEarcon,
  sampleRate: number,
): VoicePilotEarconPcm {
  const pcm =
    kind === "assistant-end"
      ? createTonePcm(sampleRate, ASSISTANT_END_TONE)
      : createListeningBoundaryPcm(kind, sampleRate);

  return {
    pcm,
    durationMs: (pcm.byteLength / Int16Array.BYTES_PER_ELEMENT / sampleRate) * 1000,
  };
}
