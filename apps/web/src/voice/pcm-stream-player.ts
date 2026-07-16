import { VOICE_WAVEFORM_FRAME_MS } from "./pcm-waveform";

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

export interface PcmStreamPlayerSnapshot {
  contextState: string;
  contextTime: number;
  nextStartTime: number;
  queuedMs: number;
}

export interface PcmStreamPlayerEvent extends PcmStreamPlayerSnapshot {
  event:
    | "resume-start"
    | "resume-finished"
    | "resume-failed"
    | "pcm-scheduled"
    | "source-ended"
    | "stopped";
  bytes?: number;
  durationMs?: number;
  error?: string;
}

interface PcmStreamPlayerOptions {
  onActivityLevel?: (level: number) => void;
  onPlaybackChunk?: (chunk: Uint8Array) => void;
  onPlaybackEvent?: (event: PcmStreamPlayerEvent) => void;
}

export class PcmStreamPlayer {
  private nextStartTime = 0;
  private activityEndToken = 0;
  private readonly timelineTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly context: AudioContext,
    private readonly sampleRate = 24000,
    private readonly options: PcmStreamPlayerOptions = {},
  ) {}

  async resume(): Promise<void> {
    this.emitPlaybackEvent("resume-start");
    try {
      if (this.context.state !== "running" && this.context.state !== "closed") {
        await this.context.resume();
      }
      if (this.context.state !== "running") {
        throw new Error("浏览器未允许播放 Voice Pilot 提示音");
      }
      this.emitPlaybackEvent("resume-finished");
    } catch (error) {
      this.emitPlaybackEvent("resume-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  enqueue(chunk: Uint8Array): number {
    if (this.context.state === "suspended") {
      void this.resume().catch(() => undefined);
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
    this.schedulePlaybackFrames(chunk, samples, startAt, endAt);
    const queuedMs = Math.max(0, (endAt - this.context.currentTime) * 1000);
    this.emitPlaybackEvent("pcm-scheduled", {
      bytes: chunk.byteLength,
      durationMs: buffer.duration * 1000,
    });
    if (typeof source.addEventListener === "function") {
      source.addEventListener(
        "ended",
        () => {
          this.emitPlaybackEvent("source-ended", {
            bytes: chunk.byteLength,
            durationMs: buffer.duration * 1000,
          });
        },
        { once: true },
      );
    }
    return queuedMs;
  }

  stop(): void {
    this.nextStartTime = this.context.currentTime;
    this.activityEndToken += 1;
    for (const timer of this.timelineTimers) {
      clearTimeout(timer);
    }
    this.timelineTimers.clear();
    this.options.onActivityLevel?.(0);
    this.emitPlaybackEvent("stopped");
  }

  snapshot(): PcmStreamPlayerSnapshot {
    const contextTime = this.context.currentTime;
    return {
      contextState: String(this.context.state ?? "unknown"),
      contextTime,
      nextStartTime: this.nextStartTime,
      queuedMs: Math.max(0, (this.nextStartTime - contextTime) * 1000),
    };
  }

  private schedulePlaybackFrames(
    chunk: Uint8Array,
    samples: Float32Array,
    startAt: number,
    endAt: number,
  ): void {
    if (!this.options.onActivityLevel && !this.options.onPlaybackChunk) return;
    const samplesPerFrame = Math.max(
      1,
      Math.round((this.sampleRate * VOICE_WAVEFORM_FRAME_MS) / 1000),
    );
    const activityToken = (this.activityEndToken += 1);

    for (let startSample = 0; startSample < samples.length; startSample += samplesPerFrame) {
      const endSample = Math.min(samples.length, startSample + samplesPerFrame);
      const frameStartAt = startAt + startSample / this.sampleRate;
      const delayMs = Math.max(0, (frameStartAt - this.context.currentTime) * 1000);
      const framePcm = chunk.slice(
        startSample * Int16Array.BYTES_PER_ELEMENT,
        endSample * Int16Array.BYTES_PER_ELEMENT,
      );
      const activityLevel = float32ActivityLevel(samples.subarray(startSample, endSample));
      this.scheduleTimer(() => {
        this.options.onActivityLevel?.(activityLevel);
        this.options.onPlaybackChunk?.(framePcm);
      }, delayMs);
    }

    if (this.options.onActivityLevel) {
      const endDelayMs = Math.max(0, (endAt - this.context.currentTime) * 1000);
      this.scheduleTimer(() => {
        if (activityToken === this.activityEndToken) {
          this.options.onActivityLevel?.(0);
        }
      }, endDelayMs);
    }
  }

  private scheduleTimer(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timelineTimers.delete(timer);
      callback();
    }, delayMs);
    this.timelineTimers.add(timer);
  }

  private emitPlaybackEvent(
    event: PcmStreamPlayerEvent["event"],
    details: Pick<PcmStreamPlayerEvent, "bytes" | "durationMs" | "error"> = {},
  ): void {
    this.options.onPlaybackEvent?.({ event, ...this.snapshot(), ...details });
  }
}
