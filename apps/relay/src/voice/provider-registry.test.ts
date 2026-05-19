import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCapabilities } from "@dev-anywhere/shared";
import type { BailianAsrClient, BailianAsrConfig } from "./bailian-asr.js";
import type { BailianTtsClient, BailianTtsConfig } from "./bailian-tts.js";
import { createBailianVoiceProvider } from "./bailian-provider.js";
import type { StoredVoiceConfig } from "./config-store.js";
import { createVoiceProviderRegistry } from "./provider.js";

class FakeAsrClient extends EventEmitter {
  sendPcm(): void {}
  stop(): void {}
  close(): void {}
}

class FakeTtsClient extends EventEmitter {
  speak(): void {}
  close(): void {}
}

function config(overrides: Partial<StoredVoiceConfig> = {}): StoredVoiceConfig {
  return {
    provider: "aliyun-bailian",
    apiKey: "sk-test",
    region: "intl",
    asrModel: "qwen3-asr-flash-realtime",
    ttsModel: "cosyvoice-v3-plus",
    ttsVoice: "longanhuan",
    ...overrides,
  };
}

describe("voice provider registry", () => {
  it("resolves the selected provider and rejects unsupported provider ids", () => {
    const provider = createBailianVoiceProvider();
    const registry = createVoiceProviderRegistry([provider]);

    expect(registry.current(config())).toBe(provider);
    expect(() =>
      registry.current({ ...config(), provider: "other-provider" } as unknown as StoredVoiceConfig),
    ).toThrow("Unsupported voice provider: other-provider");
  });

  it("adapts Bailian config into provider-agnostic ASR and TTS clients", () => {
    const asrConfigs: BailianAsrConfig[] = [];
    const ttsConfigs: BailianTtsConfig[] = [];
    const asrFactory = vi.fn((nextConfig: BailianAsrConfig) => {
      asrConfigs.push(nextConfig);
      return new FakeAsrClient() as unknown as BailianAsrClient;
    });
    const ttsFactory = vi.fn((nextConfig: BailianTtsConfig) => {
      ttsConfigs.push(nextConfig);
      return new FakeTtsClient() as unknown as BailianTtsClient;
    });

    const provider = createBailianVoiceProvider({
      asrClientFactory: asrFactory,
      ttsClientFactory: ttsFactory,
    });

    provider.createAsrClient(config(), { sampleRate: 16000, language: "zh" });
    provider.createTtsClient(config(), { sampleRate: 24000 });

    expect(asrConfigs).toEqual([
      {
        apiKey: "sk-test",
        region: "intl",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
    ]);
    expect(ttsConfigs).toEqual([
      {
        apiKey: "sk-test",
        region: "intl",
        model: "cosyvoice-v3-plus",
        voice: "longanhuan",
        sampleRate: 24000,
      },
    ]);
  });

  it("routes capabilities and test calls through the selected provider", async () => {
    const capabilities: VoiceCapabilities = {
      asrModels: [{ value: "asr", label: "ASR", source: "official" }],
      ttsModels: [{ value: "tts", label: "TTS", source: "official" }],
      ttsVoices: [{ value: "voice", label: "Voice", source: "official" }],
    };
    const provider = createBailianVoiceProvider({
      capabilitiesProvider: { read: vi.fn(async () => capabilities) },
      configTester: { test: vi.fn(async () => ({ transcript: "语音助手测试" })) },
    });

    await expect(provider.readCapabilities(config())).resolves.toBe(capabilities);
    await expect(provider.testConfig(config())).resolves.toEqual({ transcript: "语音助手测试" });
  });
});
