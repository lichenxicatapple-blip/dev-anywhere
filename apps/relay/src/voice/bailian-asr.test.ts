import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBailianAsrClient } from "./bailian-asr.js";

class MockProviderSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = MockProviderSocket.CONNECTING;
  sent: Array<string | Buffer> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  open(): void {
    this.readyState = MockProviderSocket.OPEN;
    this.emit("open");
  }

  json(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }
}

function parseSentJson(socket: MockProviderSocket, index: number): unknown {
  const raw = socket.sent[index];
  if (typeof raw !== "string") throw new Error(`sent[${index}] is not JSON text`);
  return JSON.parse(raw);
}

function eventIds(): () => string {
  let index = 0;
  return () => `event-${++index}`;
}

describe("Bailian ASR adapter", () => {
  it("connects to the model endpoint with bearer authorization and sends session.update", () => {
    let socket: MockProviderSocket | undefined;
    const factory = vi.fn((url: string, options: { headers?: Record<string, string> }) => {
      socket = new MockProviderSocket();
      expect(url).toBe(
        "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
      );
      expect(options.headers?.Authorization).toBe("bearer sk-test");
      expect(options.headers?.["OpenAI-Beta"]).toBe("realtime=v1");
      return socket;
    });

    createBailianAsrClient(
      {
        apiKey: "sk-test",
        region: "intl",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
      { eventIdFactory: eventIds(), socketFactory: factory },
    );

    socket?.open();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(parseSentJson(socket!, 0)).toMatchObject({
      type: "session.update",
      event_id: "event-1",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: { language: "zh" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.8,
          silence_duration_ms: 1200,
        },
      },
    });
  });

  it("buffers PCM until session.updated and finishes the ASR session on stop", () => {
    let socket: MockProviderSocket | undefined;
    const client = createBailianAsrClient(
      {
        apiKey: "sk-test",
        region: "cn",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
      {
        eventIdFactory: eventIds(),
        socketFactory: (url, options) => {
          socket = new MockProviderSocket();
          expect(url).toBe(
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
          );
          expect(options.headers?.Authorization).toBe("bearer sk-test");
          return socket;
        },
      },
    );

    socket?.open();
    client.sendPcm(Buffer.from([1, 2, 3, 4]));
    expect(socket?.sent).toHaveLength(1);

    socket?.json({ type: "session.updated" });
    client.stop();

    expect(parseSentJson(socket!, 1)).toEqual({
      event_id: "event-2",
      type: "input_audio_buffer.append",
      audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    expect(parseSentJson(socket!, 2)).toEqual({
      event_id: "event-3",
      type: "session.finish",
    });
  });

  it("normalizes provider partial, final, and error events", () => {
    let socket: MockProviderSocket | undefined;
    const client = createBailianAsrClient(
      {
        apiKey: "sk-test",
        region: "cn",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
      {
        eventIdFactory: eventIds(),
        socketFactory: () => {
          socket = new MockProviderSocket();
          return socket;
        },
      },
    );
    const events: unknown[] = [];
    client.on("partial", (text) => events.push({ type: "partial", text }));
    client.on("final", (text) => events.push({ type: "final", text }));
    client.on("error", (error) => events.push({ type: "error", message: error.message }));

    socket?.json({
      type: "conversation.item.input_audio_transcription.text",
      text: "打开",
      stash: "项目",
    });
    socket?.json({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "打开项目",
    });
    socket?.json({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "bad audio" },
    });

    expect(events).toEqual([
      { type: "partial", text: "打开项目" },
      { type: "final", text: "打开项目" },
      { type: "error", message: "bad audio" },
    ]);
  });

  it("closes the provider session after session.finished without duplicating final text", () => {
    let socket: MockProviderSocket | undefined;
    const client = createBailianAsrClient(
      {
        apiKey: "sk-test",
        region: "cn",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
      {
        socketFactory: () => {
          socket = new MockProviderSocket();
          return socket;
        },
      },
    );
    const final = vi.fn();
    const closed = vi.fn();
    client.on("final", final);
    client.on("closed", closed);

    socket?.json({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "打开项目",
    });
    socket?.json({ type: "session.finished", transcript: "打开项目" });

    expect(final).toHaveBeenCalledOnce();
    expect(final).toHaveBeenCalledWith("打开项目");
    expect(closed).toHaveBeenCalledOnce();
    expect(socket?.readyState).toBe(3);
  });
});
