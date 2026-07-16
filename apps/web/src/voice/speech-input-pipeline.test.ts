import { describe, expect, it, vi } from "vitest";
import { SpeechInputPipeline, type SpeechAudioStream } from "./speech-input-pipeline";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function streamSpies(): SpeechAudioStream & {
  send: ReturnType<typeof vi.fn<(chunk: Uint8Array) => void>>;
  finish: ReturnType<typeof vi.fn<() => void>>;
  abort: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    send: vi.fn<(chunk: Uint8Array) => void>(),
    finish: vi.fn<() => void>(),
    abort: vi.fn<() => void>(),
  };
}

describe("SpeechInputPipeline", () => {
  it("keeps silence local and retains only a bounded pre-roll", () => {
    const openStream = vi.fn<() => Promise<SpeechAudioStream>>();
    const pipeline = new SpeechInputPipeline({
      preRollBytes: 4,
      openStream,
      onError: vi.fn(),
    });

    pipeline.pushFrame(Uint8Array.from([1, 2]));
    pipeline.pushFrame(Uint8Array.from([3, 4]));
    pipeline.pushFrame(Uint8Array.from([5, 6]));

    expect(openStream).not.toHaveBeenCalled();
    expect(pipeline.snapshot()).toMatchObject({ state: "armed", preRollBytes: 4 });
  });

  it("opens once on confirmed speech and flushes pre-roll plus frames captured while opening", async () => {
    const opening = deferred<SpeechAudioStream>();
    const stream = streamSpies();
    const pipeline = new SpeechInputPipeline({
      preRollBytes: 4,
      openStream: () => opening.promise,
      onError: vi.fn(),
    });
    pipeline.pushFrame(Uint8Array.from([1, 2]));
    pipeline.pushFrame(Uint8Array.from([3, 4]));

    pipeline.speechStarted();
    pipeline.pushFrame(Uint8Array.from([5, 6]));
    opening.resolve(stream);
    await Promise.resolve();

    expect(stream.send.mock.calls.map(([frame]) => Array.from(frame as Uint8Array))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(pipeline.snapshot().state).toBe("streaming");
  });

  it("finishes after buffered audio when speech ends before the ASR stream is ready", async () => {
    const opening = deferred<SpeechAudioStream>();
    const stream = streamSpies();
    const pipeline = new SpeechInputPipeline({
      preRollBytes: 8,
      openStream: () => opening.promise,
      onError: vi.fn(),
    });
    pipeline.pushFrame(Uint8Array.from([1, 2]));
    pipeline.speechStarted();
    pipeline.pushFrame(Uint8Array.from([3, 4]));
    pipeline.speechFinished();

    opening.resolve(stream);
    await Promise.resolve();

    expect(stream.send).toHaveBeenCalledTimes(2);
    expect(stream.finish).toHaveBeenCalledTimes(1);
    expect(pipeline.snapshot().state).toBe("complete");
  });

  it("aborts a late stream after cancellation", async () => {
    const opening = deferred<SpeechAudioStream>();
    const stream = streamSpies();
    const pipeline = new SpeechInputPipeline({
      preRollBytes: 8,
      openStream: () => opening.promise,
      onError: vi.fn(),
    });
    pipeline.speechStarted();
    pipeline.cancel();

    opening.resolve(stream);
    await Promise.resolve();

    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(stream.send).not.toHaveBeenCalled();
  });

  it("rearms a completed pipeline without replacing the audio capture", async () => {
    const streams = [streamSpies(), streamSpies()];
    const openStream = vi
      .fn<() => Promise<SpeechAudioStream>>()
      .mockResolvedValueOnce(streams[0]!)
      .mockResolvedValueOnce(streams[1]!);
    const pipeline = new SpeechInputPipeline({
      preRollBytes: 8,
      openStream,
      onError: vi.fn(),
    });

    pipeline.speechStarted();
    await Promise.resolve();
    pipeline.speechFinished();
    expect(pipeline.snapshot().state).toBe("complete");

    expect(pipeline.rearm()).toBe(true);
    pipeline.pushFrame(Uint8Array.from([1, 2]));
    pipeline.speechStarted();
    await Promise.resolve();

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(streams[1]?.send).toHaveBeenCalledWith(Uint8Array.from([1, 2]));
    expect(pipeline.snapshot()).toMatchObject({
      state: "streaming",
      speechEnded: false,
    });
  });
});
