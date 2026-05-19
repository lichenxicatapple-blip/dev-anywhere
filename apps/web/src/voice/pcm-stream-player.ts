export function int16PcmToFloat32(chunk: Uint8Array): Float32Array {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const sampleCount = Math.floor(chunk.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

export class PcmStreamPlayer {
  private nextStartTime = 0;

  constructor(
    private readonly context: AudioContext,
    private readonly sampleRate = 24000,
  ) {}

  enqueue(chunk: Uint8Array): number {
    const samples = int16PcmToFloat32(chunk);
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime, this.nextStartTime);
    source.start(startAt);
    const endAt = startAt + buffer.duration;
    this.nextStartTime = endAt;
    return Math.max(0, (endAt - this.context.currentTime) * 1000);
  }

  stop(): void {
    this.nextStartTime = this.context.currentTime;
  }
}
