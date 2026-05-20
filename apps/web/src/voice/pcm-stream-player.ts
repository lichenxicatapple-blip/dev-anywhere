export function int16PcmToFloat32(chunk: Uint8Array): Float32Array {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const sampleCount = Math.floor(chunk.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

function float32ActivityLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  const stride = Math.max(1, Math.floor(samples.length / 512));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += stride) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.min(1, Math.sqrt(sum / count) * 10);
}

interface PcmStreamPlayerOptions {
  onActivityLevel?: (level: number) => void;
}

export class PcmStreamPlayer {
  private nextStartTime = 0;
  private activityEndToken = 0;
  private readonly activityTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly context: AudioContext,
    private readonly sampleRate = 24000,
    private readonly options: PcmStreamPlayerOptions = {},
  ) {}

  enqueue(chunk: Uint8Array): number {
    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
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
    this.scheduleActivity(float32ActivityLevel(samples), startAt, endAt);
    return Math.max(0, (endAt - this.context.currentTime) * 1000);
  }

  stop(): void {
    this.nextStartTime = this.context.currentTime;
    this.activityEndToken += 1;
    for (const timer of this.activityTimers) {
      clearTimeout(timer);
    }
    this.activityTimers.clear();
    this.options.onActivityLevel?.(0);
  }

  private scheduleActivity(level: number, startAt: number, endAt: number): void {
    if (!this.options.onActivityLevel) return;
    const token = (this.activityEndToken += 1);
    const startDelayMs = Math.max(0, (startAt - this.context.currentTime) * 1000);
    const endDelayMs = Math.max(startDelayMs, (endAt - this.context.currentTime) * 1000);
    this.scheduleTimer(() => this.options.onActivityLevel?.(level), startDelayMs);
    this.scheduleTimer(() => {
      if (token === this.activityEndToken) {
        this.options.onActivityLevel?.(0);
      }
    }, endDelayMs);
  }

  private scheduleTimer(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.activityTimers.delete(timer);
      callback();
    }, delayMs);
    this.activityTimers.add(timer);
  }
}
