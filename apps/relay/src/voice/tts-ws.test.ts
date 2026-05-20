import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { StoredVoiceConfig, VoiceConfigStore } from "./config-store.js";
import type { VoiceTtsProviderClient, VoiceProviderRegistry } from "./provider.js";
import { handleVoiceTtsConnection } from "./tts-ws.js";

class MockClientSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Array<string | Buffer> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  speak(requestId: string, text: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ type: "speak", requestId, text })));
  }

  jsonMessages(): unknown[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item));
  }
}

class MockTtsProvider extends EventEmitter implements VoiceTtsProviderClient {
  spoken: string[] = [];
  closed = false;

  speak(text: string): void {
    this.spoken.push(text);
  }

  close(): void {
    this.closed = true;
  }
}

function createLoggerFake(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

function createHarness() {
  const clients: MockTtsProvider[] = [];
  const config: StoredVoiceConfig = {
    provider: "aliyun-bailian",
    region: "cn",
    asrModel: "qwen3-asr-flash-realtime",
    ttsModel: "cosyvoice-v3-flash",
    ttsVoice: "longanhuan",
    turnIdleSeconds: 3,
    apiKey: "sk-test",
  };
  const store = {
    readSecret: () => config,
  } as unknown as VoiceConfigStore;
  const providers = {
    current: () => ({
      id: "aliyun-bailian",
      createTtsClient: () => {
        const client = new MockTtsProvider();
        clients.push(client);
        return client;
      },
      createAsrClient: () => {
        throw new Error("not used");
      },
      readCapabilities: async () => {
        throw new Error("not used");
      },
      testConfig: async () => {
        throw new Error("not used");
      },
    }),
  } as unknown as VoiceProviderRegistry;
  const logger = createLoggerFake();
  const ws = new MockClientSocket();

  handleVoiceTtsConnection(ws as unknown as WebSocket, store, logger, providers);

  return { clients, logger, ws };
}

describe("handleVoiceTtsConnection", () => {
  it("logs request metrics when a TTS request finishes", () => {
    const { clients, logger, ws } = createHarness();

    ws.speak("req-1", "你好继续。");
    clients[0]?.emit("started");
    clients[0]?.emit("audio", Buffer.from([1, 2]));
    clients[0]?.emit("audio", Buffer.from([3, 4, 5]));
    clients[0]?.emit("finished");

    expect(ws.jsonMessages()).toEqual([
      { type: "started", requestId: "req-1" },
      { type: "finished", requestId: "req-1" },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        textChars: 5,
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanhuan",
      }),
      "Voice TTS request received",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        audioBytes: 5,
        audioChunks: 2,
        durationMs: expect.any(Number),
        firstAudioMs: expect.any(Number),
      }),
      "Voice TTS finished",
    );
  });

  it("does not notify the browser when the idle provider closes after a finished request", () => {
    const { clients, logger, ws } = createHarness();

    ws.speak("req-1", "你好继续。");
    clients[0]?.emit("started");
    clients[0]?.emit("finished");
    clients[0]?.emit("closed", 1000, "Bye");

    expect(ws.jsonMessages()).toEqual([
      { type: "started", requestId: "req-1" },
      { type: "finished", requestId: "req-1" },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { code: 1000, reason: "Bye" },
      "Voice TTS provider closed",
    );

    ws.speak("req-2", "第二段");

    expect(clients).toHaveLength(2);
    expect(clients[1]?.spoken).toEqual(["第二段"]);
  });

  it("reports provider close during active speech and accepts the next request", () => {
    const { clients, logger, ws } = createHarness();

    ws.speak("req-1", "第一段");
    clients[0]?.emit("started");
    clients[0]?.emit("audio", Buffer.from([1, 2, 3]));
    clients[0]?.emit("closed", 1006, "abnormal closure");

    expect(ws.jsonMessages()).toEqual([
      { type: "started", requestId: "req-1" },
      {
        type: "error",
        requestId: "req-1",
        errorCode: "provider_closed",
        error: "Voice TTS provider closed before finishing",
      },
      { type: "closed", code: 1006, reason: "abnormal closure" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        audioBytes: 3,
        audioChunks: 1,
        code: 1006,
        reason: "abnormal closure",
      }),
      "Voice TTS provider closed before finishing",
    );

    ws.speak("req-2", "第二段");

    expect(clients).toHaveLength(2);
    expect(clients[1]?.spoken).toEqual(["第二段"]);
  });

  it("logs client websocket close during active speech before cleanup", () => {
    const { clients, logger, ws } = createHarness();

    ws.speak("req-1", "第二段");
    clients[0]?.emit("started");
    clients[0]?.emit("audio", Buffer.from([1, 2, 3, 4]));
    ws.emit("close", 1006, Buffer.alloc(0));

    expect(clients[0]?.closed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        audioBytes: 4,
        audioChunks: 1,
        code: 1006,
        reason: "",
      }),
      "Voice TTS client websocket closed before finishing",
    );
  });
});
