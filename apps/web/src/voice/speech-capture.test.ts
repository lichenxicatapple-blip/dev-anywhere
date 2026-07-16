import { describe, expect, it, vi } from "vitest";
import {
  createSpeechCapture,
  resolveVoiceSpeechSource,
  type VoiceSpeechFrame,
} from "./speech-capture";
import type { VoiceActivityClassifier } from "./web-rtc-vad";

function fakeClassifier(results: boolean[] = []) {
  let index = 0;
  const classifier: VoiceActivityClassifier = {
    process: vi.fn(() => results[index++] ?? false),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  return classifier;
}

function fakeAudioContext() {
  const stopTrack = vi.fn();
  const input = {
    buffer: null as AudioBuffer | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const createScriptProcessor = vi.fn(() => processor);
  const context = {
    sampleRate: 16_000,
    state: "suspended",
    destination: {},
    decodeAudioData: vi.fn().mockResolvedValue({ duration: 1 }),
    createBufferSource: vi.fn(() => input),
    createMediaStreamSource: vi.fn(() => input),
    createScriptProcessor,
    resume: vi.fn(async function (this: { state: string }) {
      this.state = "running";
    }),
    close: vi.fn(async function (this: { state: string }) {
      this.state = "closed";
    }),
  } as unknown as AudioContext;
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  return { context, createScriptProcessor, input, processor, stream, stopTrack };
}

describe("speech capture", () => {
  it("uses the controlled fixture only when the build and query enable it", () => {
    expect(resolveVoiceSpeechSource("?voice-fixture=default", true)).toEqual({
      kind: "fixture",
      url: "/__dev_anywhere_debug/voice-fixture",
    });
    expect(
      resolveVoiceSpeechSource("?voice-fixture=https://example.com/arbitrary.wav", true),
    ).toEqual({ kind: "microphone" });
    expect(resolveVoiceSpeechSource("?voice-fixture=default", false)).toEqual({
      kind: "microphone",
    });
  });

  it("frames microphone PCM and emits sustained speech transitions", async () => {
    const audio = fakeAudioContext();
    const classifier = fakeClassifier([...Array(10).fill(true), ...Array(30).fill(false)]);
    const frames: VoiceSpeechFrame[] = [];
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const capture = await createSpeechCapture(
      {
        source: { kind: "microphone" },
        onFrame: (frame) => frames.push(frame),
        onSpeechStart,
        onSpeechEnd,
      },
      {
        createVad: vi.fn().mockResolvedValue(classifier),
        getUserMedia: vi.fn().mockResolvedValue(audio.stream),
        createAudioContext: () => audio.context,
        fetch: vi.fn(),
      },
    );

    expect(audio.createScriptProcessor).toHaveBeenCalledWith(512, 1, 1);

    await capture.start();
    const samples = new Float32Array(320 * 40).fill(0.25);
    audio.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);

    expect(frames).toHaveLength(40);
    expect(frames[0]).toMatchObject({ speechProbability: 1, activityLevel: 1 });
    expect(frames[0]?.pcm.byteLength).toBe(640);
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onSpeechEnd).toHaveBeenCalledOnce();

    await capture.stop();
    expect(classifier.destroy).toHaveBeenCalledOnce();
    expect(audio.stopTrack).toHaveBeenCalledOnce();
  });

  it("decodes and plays the controlled fixture through the same detector", async () => {
    const audio = fakeAudioContext();
    const classifier = fakeClassifier();
    const fetchFixture = vi
      .fn()
      .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const capture = await createSpeechCapture(
      {
        source: { kind: "fixture", url: "/__dev_anywhere_debug/voice-fixture" },
        onFrame: vi.fn(),
        onSpeechStart: vi.fn(),
        onSpeechEnd: vi.fn(),
      },
      {
        createVad: vi.fn().mockResolvedValue(classifier),
        getUserMedia: vi.fn(),
        createAudioContext: () => audio.context,
        fetch: fetchFixture,
      },
    );

    await capture.start();
    expect(fetchFixture).toHaveBeenCalledWith("/__dev_anywhere_debug/voice-fixture");
    expect(audio.input.start).toHaveBeenCalledOnce();

    await capture.stop();
    expect(audio.input.stop).toHaveBeenCalledOnce();
    expect(audio.context.close).toHaveBeenCalledOnce();
  });
});
