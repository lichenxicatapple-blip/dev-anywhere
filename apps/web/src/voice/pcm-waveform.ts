export interface PcmWaveformBin {
  min: number;
  max: number;
}

export const VOICE_WAVEFORM_BIN_CAPACITY = 64;
export const VOICE_WAVEFORM_FLOOR_DB = -60;
export const VOICE_WAVEFORM_FRAME_MS = 32;

export function pcmWaveformDisplayValue(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const amplitude = Math.min(1, Math.abs(value));
  const decibels = 20 * Math.log10(amplitude);
  const normalized = Math.max(
    0,
    Math.min(1, (decibels - VOICE_WAVEFORM_FLOOR_DB) / -VOICE_WAVEFORM_FLOOR_DB),
  );
  return value < 0 ? -normalized : normalized;
}

export function int16PcmEnvelope(chunk: Uint8Array, requestedBinCount = 8): PcmWaveformBin[] {
  const sampleCount = Math.floor(chunk.byteLength / 2);
  if (sampleCount === 0 || !Number.isFinite(requestedBinCount) || requestedBinCount <= 0) {
    return [];
  }

  const binCount = Math.min(sampleCount, Math.max(1, Math.floor(requestedBinCount)));
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const bins: PcmWaveformBin[] = [];

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    const start = Math.floor((binIndex * sampleCount) / binCount);
    const end = Math.max(start + 1, Math.floor(((binIndex + 1) * sampleCount) / binCount));
    let min = 1;
    let max = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const sample = view.getInt16(sampleIndex * 2, true) / 32768;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }

    bins.push({ min, max });
  }

  return bins;
}
