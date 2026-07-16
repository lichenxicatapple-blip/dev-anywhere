import fvadWasmUrl from "@echogarden/fvad-wasm/fvad.wasm?url";
import type { FvadWasmModule } from "@echogarden/fvad-wasm";

export const WEB_RTC_VAD_SAMPLE_RATE = 16_000;
export const WEB_RTC_VAD_FRAME_MS = 20;
export const WEB_RTC_VAD_FRAME_SAMPLES = (WEB_RTC_VAD_SAMPLE_RATE * WEB_RTC_VAD_FRAME_MS) / 1000;
const WEB_RTC_VAD_FRAME_BYTES = WEB_RTC_VAD_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;

export interface VoiceActivityClassifier {
  process(frame: Uint8Array): boolean;
  reset(): void;
  destroy(): void;
}

let modulePromise: Promise<FvadWasmModule> | null = null;

async function loadFvadModule(): Promise<FvadWasmModule> {
  modulePromise ??= import("@echogarden/fvad-wasm").then(({ default: createFvadWasm }) =>
    createFvadWasm({
      locateFile: (path) => (path.endsWith(".wasm") ? fvadWasmUrl : path),
    }),
  );
  return modulePromise;
}

export class WebRtcVadClassifier implements VoiceActivityClassifier {
  private destroyed = false;

  private constructor(
    private readonly module: FvadWasmModule,
    private readonly handle: number,
    private readonly framePointer: number,
  ) {}

  static async create(mode: 0 | 1 | 2 | 3 = 3): Promise<WebRtcVadClassifier> {
    const module = await loadFvadModule();
    const handle = module._fvad_new();
    if (!handle) throw new Error("无法初始化浏览器语音活动检测器");
    const framePointer = module._malloc(WEB_RTC_VAD_FRAME_BYTES);
    if (!framePointer) {
      module._fvad_free(handle);
      throw new Error("无法分配浏览器语音活动检测缓冲区");
    }
    if (module._fvad_set_sample_rate(handle, WEB_RTC_VAD_SAMPLE_RATE) !== 0) {
      module._free(framePointer);
      module._fvad_free(handle);
      throw new Error("浏览器语音活动检测器不支持 16 kHz 音频");
    }
    if (module._fvad_set_mode(handle, mode) !== 0) {
      module._free(framePointer);
      module._fvad_free(handle);
      throw new Error("无法配置浏览器语音活动检测器");
    }
    return new WebRtcVadClassifier(module, handle, framePointer);
  }

  process(frame: Uint8Array): boolean {
    if (this.destroyed) throw new Error("浏览器语音活动检测器已释放");
    if (frame.byteLength !== WEB_RTC_VAD_FRAME_BYTES) {
      throw new Error(`语音活动检测帧必须为 ${WEB_RTC_VAD_FRAME_BYTES} 字节`);
    }
    this.module.HEAPU8.set(frame, this.framePointer);
    const result = this.module._fvad_process(
      this.handle,
      this.framePointer,
      WEB_RTC_VAD_FRAME_SAMPLES,
    );
    if (result < 0) throw new Error("浏览器语音活动检测失败");
    return result === 1;
  }

  reset(): void {
    if (!this.destroyed) this.module._fvad_reset(this.handle);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.module._free(this.framePointer);
    this.module._fvad_free(this.handle);
  }
}

export type VoiceActivityTransition = "none" | "speech-start" | "speech-end";

interface VoiceActivityGateOptions {
  startSpeechFrames?: number;
  endSilenceFrames?: number;
}

export class VoiceActivityGate {
  private readonly startSpeechFrames: number;
  private readonly endSilenceFrames: number;
  private active = false;
  private speechFrames = 0;
  private silenceFrames = 0;

  constructor(options: VoiceActivityGateOptions = {}) {
    this.startSpeechFrames = options.startSpeechFrames ?? 10;
    this.endSilenceFrames = options.endSilenceFrames ?? 30;
    if (this.startSpeechFrames < 1 || this.endSilenceFrames < 1) {
      throw new Error("Invalid voice activity gate configuration");
    }
  }

  push(isSpeech: boolean): VoiceActivityTransition {
    if (!this.active) {
      this.speechFrames = isSpeech ? this.speechFrames + 1 : 0;
      if (this.speechFrames >= this.startSpeechFrames) {
        this.active = true;
        this.speechFrames = 0;
        this.silenceFrames = 0;
        return "speech-start";
      }
      return "none";
    }

    if (isSpeech) {
      this.silenceFrames = 0;
      return "none";
    }
    this.silenceFrames += 1;
    if (this.silenceFrames < this.endSilenceFrames) return "none";
    this.active = false;
    this.silenceFrames = 0;
    return "speech-end";
  }

  reset(): void {
    this.active = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }
}

export class PcmFrameSlicer {
  private readonly pending = new Float32Array(WEB_RTC_VAD_FRAME_SAMPLES);
  private pendingLength = 0;

  push(samples: Float32Array, onFrame: (frame: Float32Array) => void): void {
    let offset = 0;
    if (this.pendingLength > 0) {
      const needed = WEB_RTC_VAD_FRAME_SAMPLES - this.pendingLength;
      const copied = Math.min(needed, samples.length);
      this.pending.set(samples.subarray(0, copied), this.pendingLength);
      this.pendingLength += copied;
      offset += copied;
      if (this.pendingLength === WEB_RTC_VAD_FRAME_SAMPLES) {
        onFrame(this.pending.slice());
        this.pendingLength = 0;
      }
    }
    while (offset + WEB_RTC_VAD_FRAME_SAMPLES <= samples.length) {
      onFrame(samples.slice(offset, offset + WEB_RTC_VAD_FRAME_SAMPLES));
      offset += WEB_RTC_VAD_FRAME_SAMPLES;
    }
    if (offset < samples.length) {
      const remainder = samples.subarray(offset);
      this.pending.set(remainder, 0);
      this.pendingLength = remainder.length;
    }
  }

  reset(): void {
    this.pendingLength = 0;
  }
}
