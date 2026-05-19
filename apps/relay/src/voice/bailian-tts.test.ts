import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBailianTtsClient } from "./bailian-tts.js";

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

  binary(payload: Buffer): void {
    this.emit("message", payload);
  }
}

function parseSentJson(socket: MockProviderSocket, index: number): unknown {
  const raw = socket.sent[index];
  if (typeof raw !== "string") throw new Error(`sent[${index}] is not JSON text`);
  return JSON.parse(raw);
}

describe("Bailian TTS adapter", () => {
  it("connects to the region endpoint with bearer authorization and sends run-task on speak", () => {
    let socket: MockProviderSocket | undefined;
    const factory = vi.fn((url: string, options: { headers?: Record<string, string> }) => {
      socket = new MockProviderSocket();
      expect(url).toBe("wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference");
      expect(options.headers?.Authorization).toBe("bearer sk-test");
      return socket;
    });
    const client = createBailianTtsClient(
      {
        apiKey: "sk-test",
        region: "intl",
        model: "cosyvoice-v3-flash",
        voice: "longanyang",
        sampleRate: 24000,
      },
      {
        socketFactory: factory,
        taskIdFactory: () => "task-1",
      },
    );

    client.speak("你好");
    socket?.open();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(parseSentJson(socket!, 0)).toMatchObject({
      header: {
        action: "run-task",
        task_id: "task-1",
        streaming: "duplex",
      },
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: "cosyvoice-v3-flash",
        input: {},
        parameters: {
          text_type: "PlainText",
          voice: "longanyang",
          format: "pcm",
          sample_rate: 24000,
        },
      },
    });
  });

  it("sends continue-task then finish-task after task-started", () => {
    let socket: MockProviderSocket | undefined;
    const client = createBailianTtsClient(
      {
        apiKey: "sk-test",
        region: "cn",
        model: "cosyvoice-v3-flash",
        voice: "longanyang",
        sampleRate: 24000,
      },
      {
        socketFactory: (url, options) => {
          socket = new MockProviderSocket();
          expect(url).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference");
          expect(options.headers?.Authorization).toBe("bearer sk-test");
          return socket;
        },
        taskIdFactory: () => "task-1",
      },
    );

    client.speak("开始编码");
    socket?.open();
    socket?.json({ header: { event: "task-started", task_id: "task-1" } });

    expect(parseSentJson(socket!, 1)).toMatchObject({
      header: { action: "continue-task", task_id: "task-1" },
      payload: { input: { text: "开始编码" } },
    });
    expect(parseSentJson(socket!, 2)).toMatchObject({
      header: { action: "finish-task", task_id: "task-1" },
    });
  });

  it("forwards binary PCM chunks and normalized lifecycle events", () => {
    let socket: MockProviderSocket | undefined;
    const client = createBailianTtsClient(
      {
        apiKey: "sk-test",
        region: "cn",
        model: "cosyvoice-v3-flash",
        voice: "longanyang",
        sampleRate: 24000,
      },
      {
        socketFactory: () => {
          socket = new MockProviderSocket();
          return socket;
        },
        taskIdFactory: () => "task-1",
      },
    );
    const events: unknown[] = [];
    client.on("started", () => events.push({ type: "started" }));
    client.on("audio", (chunk) => events.push({ type: "audio", chunk }));
    client.on("finished", () => events.push({ type: "finished" }));
    client.on("error", (error) => events.push({ type: "error", message: error.message }));

    client.speak("继续");
    socket?.open();
    socket?.json({ header: { event: "task-started", task_id: "task-1" } });
    socket?.binary(Buffer.from([1, 2, 3]));
    socket?.json({ header: { event: "task-finished", task_id: "task-1" } });
    socket?.json({ header: { event: "task-failed", error_message: "quota exceeded" } });

    expect(events).toEqual([
      { type: "started" },
      { type: "audio", chunk: Buffer.from([1, 2, 3]) },
      { type: "finished" },
      { type: "error", message: "quota exceeded" },
    ]);
  });
});
