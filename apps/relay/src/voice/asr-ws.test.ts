import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw } from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { StoredVoiceConfig, VoiceConfigStore } from "./config-store.js";
import type { VoiceAsrProviderClient, VoiceProviderRegistry } from "./provider.js";
import { handleVoiceAsrConnection } from "./asr-ws.js";

class MockClientSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  sendJson(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }

  sendAudio(payload: Uint8Array): void {
    this.emit("message", Buffer.from(payload), true);
  }

  jsonMessages(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
  }
}

class MockAsrProvider extends EventEmitter implements VoiceAsrProviderClient {
  pcmChunks: Buffer[] = [];
  stopped = false;
  closed = false;

  sendPcm(chunk: Buffer): void {
    this.pcmChunks.push(chunk);
  }

  stop(): void {
    this.stopped = true;
  }

  close(): void {
    this.closed = true;
  }
}

function createHarness() {
  const clients: MockAsrProvider[] = [];
  const config: StoredVoiceConfig = {
    provider: "aliyun-bailian",
    region: "cn",
    asrModel: "qwen3-asr-flash-realtime",
    ttsModel: "cosyvoice-v3-flash",
    ttsVoice: "longanyang",
    turnIdleSeconds: 3,
    apiKey: "sk-test",
  };
  const store = {
    readSecret: () => config,
  } as unknown as VoiceConfigStore;
  const providers = {
    current: () => ({
      id: "aliyun-bailian",
      createAsrClient: () => {
        const client = new MockAsrProvider();
        clients.push(client);
        return client;
      },
      createTtsClient: () => {
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
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
  const ws = new MockClientSocket();

  handleVoiceAsrConnection(ws as unknown as WebSocket, store, logger, providers);

  return { clients, logger, ws };
}

describe("handleVoiceAsrConnection", () => {
  it("decodes mu-law audio and acknowledges cumulative encoded and PCM bytes", () => {
    const { clients, ws } = createHarness();
    ws.sendJson({
      type: "start",
      sessionId: "session-1",
      attemptId: "attempt-1",
      sampleRate: 16000,
      encoding: "mulaw",
    });
    clients[0]?.emit("ready");

    const pcm = new Uint8Array(new Int16Array([0, 1000, -1000, 12000]).buffer);
    const first = encodePcm16ToMuLaw(pcm.subarray(0, 4));
    const second = encodePcm16ToMuLaw(pcm.subarray(4));
    ws.sendAudio(first);
    ws.sendAudio(second);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.pcmChunks).toEqual([
      Buffer.from(decodeMuLawToPcm16(first)),
      Buffer.from(decodeMuLawToPcm16(second)),
    ]);
    expect(ws.jsonMessages()).toEqual([
      { type: "ready", attemptId: "attempt-1" },
      {
        type: "audio_ack",
        attemptId: "attempt-1",
        encodedBytes: 2,
        pcmBytes: 4,
        chunks: 1,
      },
      {
        type: "audio_ack",
        attemptId: "attempt-1",
        encodedBytes: 4,
        pcmBytes: 8,
        chunks: 2,
      },
    ]);

    ws.sendJson({ type: "stop", attemptId: "attempt-1" });
    expect(clients[0]?.stopped).toBe(true);
  });

  it("rejects legacy starts without an explicit audio encoding", () => {
    const { clients, logger, ws } = createHarness();

    ws.sendJson({
      type: "start",
      sessionId: "session-1",
      attemptId: "attempt-1",
      sampleRate: 16000,
    });

    expect(clients).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      "Ignored invalid Voice ASR client message",
    );
  });
});
