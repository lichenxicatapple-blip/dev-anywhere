import waveResampler from "wave-resampler";

const RESAMPLE_DETAILS = {
  method: "sinc",
  LPF: true,
  LPFType: "FIR",
} as const;

export function resampleMonoPcmS16le(
  audio: Buffer,
  inputSampleRate: number,
  outputSampleRate: number,
): Buffer {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM 音频数据长度无效");
  }
  if (!validSampleRate(inputSampleRate) || !validSampleRate(outputSampleRate)) {
    throw new Error("PCM 音频采样率无效");
  }
  if (inputSampleRate === outputSampleRate) return Buffer.from(audio);

  const input = new Int16Array(audio.byteLength / 2);
  for (let index = 0; index < input.length; index += 1) {
    input[index] = audio.readInt16LE(index * 2);
  }

  const samples = waveResampler.resample(
    input,
    inputSampleRate,
    outputSampleRate,
    RESAMPLE_DETAILS,
  );
  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (typeof sample !== "number" || !Number.isFinite(sample)) {
      throw new Error("PCM 音频重采样失败");
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), index * 2);
  }
  return output;
}

function validSampleRate(sampleRate: number): boolean {
  return Number.isSafeInteger(sampleRate) && sampleRate > 0;
}
