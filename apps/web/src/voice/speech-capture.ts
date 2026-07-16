import { floatToInt16Pcm } from "./pcm-capture";
import { VOICE_WAVEFORM_FRAME_MS } from "./pcm-waveform";
import {
  PcmFrameSlicer,
  VoiceActivityGate,
  WebRtcVadClassifier,
  WEB_RTC_VAD_SAMPLE_RATE,
  type VoiceActivityClassifier,
} from "./web-rtc-vad";

const DEFAULT_FIXTURE_URL = "/__dev_anywhere_debug/voice-fixture";
const CAPTURE_PROCESSOR_BUFFER_SAMPLES =
  (WEB_RTC_VAD_SAMPLE_RATE * VOICE_WAVEFORM_FRAME_MS) / 1000;

export type VoiceSpeechSource = { kind: "microphone" } | { kind: "fixture"; url: string };

export interface VoiceSpeechFrame {
  pcm: Uint8Array;
  speechProbability: number;
  activityLevel: number;
}

export interface VoiceSpeechCapture {
  source: VoiceSpeechSource["kind"];
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface VoiceSpeechCaptureOptions {
  source: VoiceSpeechSource;
  onFrame: (frame: VoiceSpeechFrame) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

interface PreparedSource {
  context: AudioContext;
  input: AudioNode;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface VoiceSpeechCaptureDependencies {
  createVad(): Promise<VoiceActivityClassifier>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(options: AudioContextOptions): AudioContext;
  fetch(input: RequestInfo | URL): Promise<Response>;
}

const defaultDependencies: VoiceSpeechCaptureDependencies = {
  createVad: () => WebRtcVadClassifier.create(3),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: (options) => new AudioContext(options),
  fetch: (input) => fetch(input),
};

function frameActivityLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / samples.length) * 10);
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function createCaptureAudioContext(dependencies: VoiceSpeechCaptureDependencies): AudioContext {
  const context = dependencies.createAudioContext({ sampleRate: WEB_RTC_VAD_SAMPLE_RATE });
  if (context.sampleRate !== WEB_RTC_VAD_SAMPLE_RATE) {
    void context.close().catch(() => undefined);
    throw new Error("浏览器无法提供 Voice Pilot 所需的 16 kHz 音频输入");
  }
  return context;
}

async function prepareMicrophoneSource(
  dependencies: VoiceSpeechCaptureDependencies,
): Promise<PreparedSource> {
  const context = createCaptureAudioContext(dependencies);
  let stream: MediaStream;
  try {
    stream = await dependencies.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
        sampleRate: WEB_RTC_VAD_SAMPLE_RATE,
      },
    });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  const input = context.createMediaStreamSource(stream);
  return {
    context,
    input,
    async start() {
      if (context.state === "suspended") await context.resume();
    },
    async stop() {
      input.disconnect();
      stopTracks(stream);
      if (context.state !== "closed") await context.close();
    },
  };
}

async function prepareFixtureSource(
  url: string,
  dependencies: VoiceSpeechCaptureDependencies,
): Promise<PreparedSource> {
  const context = createCaptureAudioContext(dependencies);
  try {
    const response = await dependencies.fetch(url);
    if (!response.ok) throw new Error(`测试录音读取失败 (${response.status})`);
    const audioBuffer = await context.decodeAudioData(await response.arrayBuffer());
    const input = context.createBufferSource();
    input.buffer = audioBuffer;
    let started = false;
    let stopped = false;
    return {
      context,
      input,
      async start() {
        if (started || stopped) return;
        started = true;
        if (context.state === "suspended") await context.resume();
        input.start();
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        if (started) {
          try {
            input.stop();
          } catch {
            // The fixture may already have reached its natural end.
          }
        }
        input.disconnect();
        if (context.state !== "closed") await context.close();
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export function resolveVoiceSpeechSource(
  search = window.location.search,
  fixtureEnabled = import.meta.env.DEV || import.meta.env.VITE_DEV_ANYWHERE_VOICE_FIXTURE === "1",
): VoiceSpeechSource {
  if (fixtureEnabled) {
    const fixture = new URLSearchParams(search).get("voice-fixture");
    if (fixture === "default") return { kind: "fixture", url: DEFAULT_FIXTURE_URL };
  }
  return { kind: "microphone" };
}

export async function createSpeechCapture(
  options: VoiceSpeechCaptureOptions,
  dependencies: VoiceSpeechCaptureDependencies = defaultDependencies,
): Promise<VoiceSpeechCapture> {
  const classifier = await dependencies.createVad();
  let preparedSource: PreparedSource;
  try {
    preparedSource =
      options.source.kind === "fixture"
        ? await prepareFixtureSource(options.source.url, dependencies)
        : await prepareMicrophoneSource(dependencies);
  } catch (error) {
    classifier.destroy();
    throw error;
  }

  const gate = new VoiceActivityGate();
  const slicer = new PcmFrameSlicer();
  const processor = preparedSource.context.createScriptProcessor(
    CAPTURE_PROCESSOR_BUFFER_SAMPLES,
    1,
    1,
  );
  let callbacksEnabled = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  processor.onaudioprocess = (event) => {
    if (!callbacksEnabled) return;
    slicer.push(event.inputBuffer.getChannelData(0), (samples) => {
      const pcm = floatToInt16Pcm(samples);
      const isSpeech = classifier.process(pcm);
      options.onFrame({
        pcm,
        speechProbability: isSpeech ? 1 : 0,
        activityLevel: frameActivityLevel(samples),
      });
      const transition = gate.push(isSpeech);
      if (transition === "speech-start") options.onSpeechStart();
      if (transition === "speech-end") options.onSpeechEnd();
    });
  };
  preparedSource.input.connect(processor);
  processor.connect(preparedSource.context.destination);

  return {
    source: options.source.kind,
    start() {
      if (stopPromise) return Promise.reject(new Error("语音采集已停止"));
      startPromise ??= (async () => {
        callbacksEnabled = true;
        await preparedSource.start();
      })();
      return startPromise;
    },
    stop() {
      stopPromise ??= (async () => {
        callbacksEnabled = false;
        processor.onaudioprocess = null;
        processor.disconnect();
        gate.reset();
        slicer.reset();
        classifier.reset();
        classifier.destroy();
        await preparedSource.stop();
      })();
      return stopPromise;
    },
  };
}
