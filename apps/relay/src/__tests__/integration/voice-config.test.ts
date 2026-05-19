import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "#src/server.js";
import type { VoiceCapabilitiesProvider } from "#src/voice/capabilities.js";
import type { VoiceConfigTester } from "#src/voice/config-test.js";
import { getPort, waitForMessageType, waitForOpen } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("voice config relay controls", () => {
  let relay: RelayServer;
  let dataDir: string;
  let port: number;
  let voiceCapabilitiesProvider: VoiceCapabilitiesProvider;
  let voiceConfigTester: VoiceConfigTester;
  const connections: WebSocket[] = [];

  async function start(): Promise<void> {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60000,
      logger,
      dataDir,
      voiceCapabilitiesProvider,
      voiceConfigTester,
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  }

  async function connectClient(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    connections.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dev-anywhere-relay-voice-"));
    voiceCapabilitiesProvider = {
      read: async () => ({
        asrModels: [
          { value: "qwen3-asr-flash-realtime-dynamic", label: "Dynamic ASR", source: "official" },
        ],
        ttsModels: [
          { value: "cosyvoice-v3-flash-dynamic", label: "Dynamic TTS", source: "official" },
        ],
        ttsVoices: [
          {
            value: "dynamic-voice",
            label: "动态音色 · 女 · 清晰自然",
            gender: "female",
            model: "cosyvoice-v3-flash-dynamic",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      }),
    };
    voiceConfigTester = {
      test: async () => ({}),
    };
    await start();
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    connections.length = 0;
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns a redacted default config without proxy binding", async () => {
    const client = await connectClient();
    const responsePromise = waitForMessageType(client, "voice_config_response");

    client.send(JSON.stringify({ type: "voice_config_request", requestId: "voice-1" }));

    const response = JSON.parse(await responsePromise);
    expect(response).toEqual({
      type: "voice_config_response",
      requestId: "voice-1",
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
      },
    });
  });

  it("updates config, redacts the API key, and persists across relay restart", async () => {
    const client = await connectClient();
    const updatePromise = waitForMessageType(client, "voice_config_update_response");

    client.send(
      JSON.stringify({
        type: "voice_config_update",
        requestId: "voice-update-1",
        config: {
          provider: "aliyun-bailian",
          apiKey: "sk-secret",
          region: "intl",
          asrModel: "qwen3-asr-flash-realtime-2026-02-10",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
        },
      }),
    );

    const updateResponse = JSON.parse(await updatePromise);
    expect(updateResponse).toMatchObject({
      type: "voice_config_update_response",
      requestId: "voice-update-1",
      success: true,
      config: {
        configured: true,
        region: "intl",
      },
    });
    expect(JSON.stringify(updateResponse)).not.toContain("sk-secret");

    await relay.close();
    await start();
    const restartedClient = await connectClient();
    const readPromise = waitForMessageType(restartedClient, "voice_config_response");

    restartedClient.send(JSON.stringify({ type: "voice_config_request", requestId: "voice-2" }));

    const readResponse = JSON.parse(await readPromise);
    expect(readResponse.config).toMatchObject({
      configured: true,
      region: "intl",
      asrModel: "qwen3-asr-flash-realtime-2026-02-10",
    });
    expect(JSON.stringify(readResponse)).not.toContain("sk-secret");
  });

  it("clears the stored API key through an explicit update", async () => {
    const client = await connectClient();
    client.send(
      JSON.stringify({
        type: "voice_config_update",
        requestId: "voice-update-key",
        config: { apiKey: "sk-secret" },
      }),
    );
    await waitForMessageType(client, "voice_config_update_response");

    const clearPromise = waitForMessageType(client, "voice_config_update_response");
    client.send(
      JSON.stringify({
        type: "voice_config_update",
        requestId: "voice-clear-key",
        config: { clearApiKey: true },
      }),
    );

    const clearResponse = JSON.parse(await clearPromise);
    expect(clearResponse).toMatchObject({
      type: "voice_config_update_response",
      requestId: "voice-clear-key",
      success: true,
      config: { configured: false },
    });
    expect(JSON.stringify(clearResponse)).not.toContain("sk-secret");
  });

  it("returns dynamic voice capabilities without proxy binding", async () => {
    const client = await connectClient();
    const responsePromise = waitForMessageType(client, "voice_capabilities_response");

    client.send(
      JSON.stringify({
        type: "voice_capabilities_request",
        requestId: "voice-capabilities-1",
        region: "cn",
      }),
    );

    const response = JSON.parse(await responsePromise);
    expect(response).toEqual({
      type: "voice_capabilities_response",
      requestId: "voice-capabilities-1",
      capabilities: {
        asrModels: [
          { value: "qwen3-asr-flash-realtime-dynamic", label: "Dynamic ASR", source: "official" },
        ],
        ttsModels: [
          { value: "cosyvoice-v3-flash-dynamic", label: "Dynamic TTS", source: "official" },
        ],
        ttsVoices: [
          {
            value: "dynamic-voice",
            label: "动态音色 · 女 · 清晰自然",
            gender: "female",
            model: "cosyvoice-v3-flash-dynamic",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      },
    });
  });

  it("tests a temporary Voice Pilot config without persisting it", async () => {
    const testedConfigs: unknown[] = [];
    voiceConfigTester = {
      test: async (config) => {
        testedConfigs.push(config);
        return {};
      },
    };
    await relay.close();
    await start();
    const client = await connectClient();
    const responsePromise = waitForMessageType(client, "voice_config_test_response");

    client.send(
      JSON.stringify({
        type: "voice_config_test",
        requestId: "voice-test-1",
        config: {
          apiKey: "sk-unsaved",
          region: "intl",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-plus",
          ttsVoice: "longanhuan",
        },
      }),
    );

    const response = JSON.parse(await responsePromise);
    expect(response).toEqual({
      type: "voice_config_test_response",
      requestId: "voice-test-1",
      success: true,
    });
    expect(testedConfigs).toEqual([
      {
        provider: "aliyun-bailian",
        apiKey: "sk-unsaved",
        region: "intl",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-plus",
        ttsVoice: "longanhuan",
      },
    ]);

    const readPromise = waitForMessageType(client, "voice_config_response");
    client.send(
      JSON.stringify({ type: "voice_config_request", requestId: "voice-read-after-test" }),
    );
    const readResponse = JSON.parse(await readPromise);
    expect(readResponse.config.configured).toBe(false);
    expect(JSON.stringify(readResponse)).not.toContain("sk-unsaved");
  });
});
