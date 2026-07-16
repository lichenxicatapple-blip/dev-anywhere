const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

function encodeSample(sampleValue: number): number {
  let sample = sampleValue;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample = Math.min(sample, MU_LAW_CLIP) + MU_LAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeSample(encodedValue: number): number {
  const value = ~encodedValue & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = ((mantissa << 3) + MU_LAW_BIAS) * 2 ** exponent - MU_LAW_BIAS;
  return sign ? -magnitude : magnitude;
}

export function encodePcm16ToMuLaw(pcm: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const encoded = new Uint8Array(sampleCount);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    encoded[index] = encodeSample(view.getInt16(index * 2, true));
  }
  return encoded;
}

export function decodeMuLawToPcm16(encoded: Uint8Array): Uint8Array {
  const pcm = new Uint8Array(encoded.byteLength * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < encoded.byteLength; index += 1) {
    view.setInt16(index * 2, decodeSample(encoded[index] ?? 0xff), true);
  }
  return pcm;
}
