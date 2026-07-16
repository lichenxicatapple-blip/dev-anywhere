import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { getPort, waitForMessageType, waitForOpen } from "../helpers.js";
import type { BailianAsrClient, BailianAsrConfig } from "#src/voice/bailian-asr.js";
import type { BailianTtsClient, BailianTtsConfig } from "#src/voice/bailian-tts.js";

const logger = createLogger({ name: "test", silent: true });

class FakeAsrClient extends EventEmitter implements BailianAsrClient {
  chunks: Buffer[] = [];
  stopped = false;
  closed = false;

  sendPcm(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  stop(): void {
    this.stopped = true;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeTtsClient extends EventEmitter implements BailianTtsClient {
  spoken: string[] = [];
  closed = false;

  speak(text: string): void {
    this.spoken.push(text);
  }

  close(): void {
    this.closed = true;
  }
}

function waitForRawMessage(ws: WebSocket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForRawMessage timeout")), timeoutMs);
    function onMessage(data: Buffer | ArrayBuffer | Buffer[]) {
      const buffer = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      try {
        JSON.parse(buffer.toString("utf8"));
        return;
      } catch {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        resolve(buffer);
      }
    }
    ws.on("message", onMessage);
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitForCondition timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tryConnect(url: string): Promise<boolean> {
  const ws = new WebSocket(url);
  return new Promise<boolean>((resolve) => {
    ws.once("open", () => {
      ws.close();
      resolve(true);
    });
    ws.once("error", () => resolve(false));
    ws.once("close", () => resolve(false));
  });
}

describe("voice websocket endpoints", () => {
  let relay: RelayServer;
  let dataDir: string;
  let port: number;
  const connections: WebSocket[] = [];
  const asrInstances: FakeAsrClient[] = [];
  const ttsInstances: FakeTtsClient[] = [];
  let lastAsrConfig: BailianAsrConfig | null = null;
  let lastTtsConfig: BailianTtsConfig | null = null;

  async function start(clientToken?: string): Promise<void> {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60000,
      logger,
      dataDir,
      clientToken,
      voiceAsrClientFactory(config) {
        lastAsrConfig = config;
        const client = new FakeAsrClient();
        asrInstances.push(client);
        return client;
      },
      voiceTtsClientFactory(config) {
        lastTtsConfig = config;
        const client = new FakeTtsClient();
        ttsInstances.push(client);
        return client;
      },
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  }

  async function connect(path: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    connections.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  async function configureVoice(): Promise<void> {
    const client = await connect("/client");
    const responsePromise = waitForMessageType(client, "voice_config_update_response");
    client.send(
      JSON.stringify({
        type: "voice_config_update",
        requestId: "voice-update",
        config: {
          apiKey: "sk-test",
          region: "intl",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
        },
      }),
    );
    await responsePromise;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dev-anywhere-relay-voice-ws-"));
    await start();
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    connections.length = 0;
    asrInstances.length = 0;
    ttsInstances.length = 0;
    lastAsrConfig = null;
    lastTtsConfig = null;
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reuses client token auth for voice websocket endpoints", async () => {
    await relay.close();
    await start("client-secret");

    await expect(tryConnect(`ws://127.0.0.1:${port}/voice/asr?token=client-secret`)).resolves.toBe(
      true,
    );
    await expect(tryConnect(`ws://127.0.0.1:${port}/voice/asr?token=wrong`)).resolves.toBe(false);
    await expect(tryConnect(`ws://127.0.0.1:${port}/voice/tts?token=client-secret`)).resolves.toBe(
      true,
    );
    await expect(tryConnect(`ws://127.0.0.1:${port}/voice/tts`)).resolves.toBe(false);
  });

  it("rejects voice startup when Bailian is not configured", async () => {
    const asr = await connect("/voice/asr");
    const errorPromise = waitForMessageType(asr, "error");

    asr.send(
      JSON.stringify({
        type: "start",
        sessionId: "s1",
        attemptId: "attempt-1",
        sampleRate: 16000,
        encoding: "pcm_s16le",
      }),
    );

    await expect(errorPromise).resolves.toEqual(
      JSON.stringify({
        type: "error",
        attemptId: "attempt-1",
        errorCode: "not_configured",
        error: "Voice provider is not configured",
      }),
    );
  });

  it("bridges ASR websocket messages to the Bailian adapter", async () => {
    await configureVoice();
    const asr = await connect("/voice/asr");
    const readyPromise = waitForMessageType(asr, "ready");
    const audioAckPromise = waitForMessageType(asr, "audio_ack");
    const partialPromise = waitForMessageType(asr, "partial");
    const finalPromise = waitForMessageType(asr, "final");

    asr.send(
      JSON.stringify({
        type: "start",
        sessionId: "s1",
        attemptId: "attempt-1",
        sampleRate: 16000,
        encoding: "pcm_s16le",
      }),
    );
    await waitForCondition(() => lastAsrConfig !== null);
    expect(lastAsrConfig).toMatchObject({
      apiKey: "sk-test",
      region: "intl",
      model: "qwen3-asr-flash-realtime",
      sampleRate: 16000,
      language: "zh",
    });
    const provider = asrInstances[0]!;
    provider.emit("ready");
    provider.emit("partial", "打开");
    provider.emit("final", "打开项目");
    asr.send(Buffer.from([1, 2, 3]));
    asr.send(JSON.stringify({ type: "stop", attemptId: "attempt-1" }));

    await expect(readyPromise).resolves.toBe(
      JSON.stringify({ type: "ready", attemptId: "attempt-1" }),
    );
    await expect(partialPromise).resolves.toBe(
      JSON.stringify({ type: "partial", attemptId: "attempt-1", text: "打开" }),
    );
    await expect(finalPromise).resolves.toBe(
      JSON.stringify({ type: "final", attemptId: "attempt-1", text: "打开项目" }),
    );
    await expect(audioAckPromise).resolves.toBe(
      JSON.stringify({
        type: "audio_ack",
        attemptId: "attempt-1",
        encodedBytes: 3,
        pcmBytes: 3,
        chunks: 1,
      }),
    );
    await waitForCondition(() => provider.chunks.length === 1 && provider.stopped);
    expect(provider.chunks).toEqual([Buffer.from([1, 2, 3])]);
    expect(provider.stopped).toBe(true);
  });

  it("ignores callbacks from an ASR provider replaced by a newer turn", async () => {
    await configureVoice();
    const asr = await connect("/voice/asr");

    asr.send(
      JSON.stringify({
        type: "start",
        sessionId: "s1",
        attemptId: "attempt-1",
        sampleRate: 16000,
        encoding: "pcm_s16le",
      }),
    );
    await waitForCondition(() => asrInstances.length === 1);
    const staleProvider = asrInstances[0]!;

    asr.send(
      JSON.stringify({
        type: "start",
        sessionId: "s1",
        attemptId: "attempt-2",
        sampleRate: 16000,
        encoding: "pcm_s16le",
      }),
    );
    await waitForCondition(() => asrInstances.length === 2);
    const activeProvider = asrInstances[1]!;
    const readyPromise = waitForMessageType(asr, "ready");
    const partialPromise = waitForMessageType(asr, "partial");

    staleProvider.emit("ready");
    staleProvider.emit("partial", "旧会话");
    staleProvider.emit("error", new Error("stale error"));
    staleProvider.emit("closed", 1000, "stale close");
    activeProvider.emit("ready");
    activeProvider.emit("partial", "新会话");

    await expect(readyPromise).resolves.toBe(
      JSON.stringify({ type: "ready", attemptId: "attempt-2" }),
    );
    await expect(partialPromise).resolves.toBe(
      JSON.stringify({ type: "partial", attemptId: "attempt-2", text: "新会话" }),
    );
    expect(staleProvider.closed).toBe(true);
  });

  it("bridges TTS websocket messages and binary PCM chunks", async () => {
    await configureVoice();
    const tts = await connect("/voice/tts");
    const startedPromise = waitForMessageType(tts, "started");
    const audioPromise = waitForRawMessage(tts);
    const finishedPromise = waitForMessageType(tts, "finished");

    tts.send(JSON.stringify({ type: "speak", requestId: "speak-1", text: "你好" }));
    await waitForCondition(() => lastTtsConfig !== null);
    expect(lastTtsConfig).toMatchObject({
      apiKey: "sk-test",
      region: "intl",
      model: "cosyvoice-v3-flash",
      voice: "longanyang",
      sampleRate: 24000,
    });
    const provider = ttsInstances[0]!;
    provider.emit("started");
    provider.emit("audio", Buffer.from([4, 5, 6]));
    provider.emit("finished");

    expect(provider.spoken).toEqual(["你好"]);
    await expect(startedPromise).resolves.toBe(
      JSON.stringify({ type: "started", requestId: "speak-1" }),
    );
    await expect(audioPromise).resolves.toEqual(Buffer.from([4, 5, 6]));
    await expect(finishedPromise).resolves.toBe(
      JSON.stringify({ type: "finished", requestId: "speak-1" }),
    );
  });
});
