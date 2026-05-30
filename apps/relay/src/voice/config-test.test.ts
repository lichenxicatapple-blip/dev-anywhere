import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BailianAsrClient, BailianAsrConfig } from "./bailian-asr.js";
import type { BailianTtsClient, BailianTtsConfig } from "./bailian-tts.js";
import { createBailianVoiceConfigTester, mergeVoiceConfigForTest } from "./config-test.js";
import type { StoredVoiceConfig } from "./config-store.js";

class MockTtsClient extends EventEmitter {
  spoken: string[] = [];
  closed = false;

  speak(text: string): void {
    this.spoken.push(text);
  }

  close(): void {
    this.closed = true;
  }
}

class MockAsrClient extends EventEmitter {
  pcm: Buffer[] = [];
  stopped = false;
  closed = false;

  sendPcm(chunk: Buffer): void {
    this.pcm.push(chunk);
  }

  stop(): void {
    this.stopped = true;
  }

  close(): void {
    this.closed = true;
  }
}

function baseConfig(overrides: Partial<StoredVoiceConfig> = {}): StoredVoiceConfig {
  return {
    provider: "aliyun-bailian",
    apiKey: "sk-current",
    region: "cn",
    asrModel: "qwen3-asr-flash-realtime",
    ttsModel: "cosyvoice-v3-flash",
    ttsVoice: "longanyang",
    turnIdleSeconds: 3,
    ...overrides,
  };
}

describe("Voice config tester", () => {
  it("merges temporary form values over the stored relay config", () => {
    expect(
      mergeVoiceConfigForTest(baseConfig(), {
        apiKey: "sk-unsaved",
        region: "intl",
        ttsModel: "cosyvoice-v3-plus",
        ttsVoice: "longanhuan",
      }),
    ).toEqual({
      provider: "aliyun-bailian",
      apiKey: "sk-unsaved",
      region: "intl",
      asrModel: "qwen3-asr-flash-realtime",
      ttsModel: "cosyvoice-v3-plus",
      ttsVoice: "longanhuan",
      turnIdleSeconds: 3,
    });
  });

  it("does not create a provider client when no API key is available", async () => {
    const ttsClientFactory = vi.fn();
    const asrClientFactory = vi.fn();
    const tester = createBailianVoiceConfigTester({ ttsClientFactory, asrClientFactory });

    await expect(tester.test(baseConfig({ apiKey: undefined }))).rejects.toThrow(
      "请先填写阿里云百炼 API Key",
    );
    expect(ttsClientFactory).not.toHaveBeenCalled();
    expect(asrClientFactory).not.toHaveBeenCalled();
  });

  it("uses fixed TTS audio to verify both synthesis and recognition, then returns playable audio", async () => {
    let tts: MockTtsClient | undefined;
    let asr: MockAsrClient | undefined;
    const ttsConfigs: BailianTtsConfig[] = [];
    const asrConfigs: BailianAsrConfig[] = [];
    const tester = createBailianVoiceConfigTester({
      sampleText: "语音助手测试",
      ttsClientFactory: (config) => {
        ttsConfigs.push(config);
        tts = new MockTtsClient();
        return tts as unknown as BailianTtsClient;
      },
      asrClientFactory: (config) => {
        asrConfigs.push(config);
        asr = new MockAsrClient();
        return asr as unknown as BailianAsrClient;
      },
    });

    const promise = tester.test(baseConfig({ apiKey: "sk-unsaved", region: "intl" }));
    expect(tts?.spoken).toEqual(["语音助手测试"]);
    const firstAudioChunk = Buffer.alloc(3200, 1);
    const secondAudioChunk = Buffer.from([2]);
    tts?.emit("audio", firstAudioChunk);
    tts?.emit("audio", secondAudioChunk);
    tts?.emit("finished");
    await vi.waitFor(() => expect(asr).toBeDefined());
    asr?.emit("ready");
    expect(asr?.pcm).toEqual([firstAudioChunk]);
    expect(asr?.stopped).toBe(false);
    await vi.waitFor(() => {
      expect(asr?.pcm).toEqual([firstAudioChunk, secondAudioChunk]);
      expect(asr?.stopped).toBe(true);
    });
    asr?.emit("final", "语音助手测试");

    await expect(promise).resolves.toEqual({
      audio: Buffer.concat([firstAudioChunk, secondAudioChunk]),
      sampleRate: 16000,
      transcript: "语音助手测试",
    });
    expect(ttsConfigs).toEqual([
      {
        apiKey: "sk-unsaved",
        region: "intl",
        model: "cosyvoice-v3-flash",
        voice: "longanyang",
        sampleRate: 16000,
      },
    ]);
    expect(asrConfigs).toEqual([
      {
        apiKey: "sk-unsaved",
        region: "intl",
        model: "qwen3-asr-flash-realtime",
        sampleRate: 16000,
        language: "zh",
      },
    ]);
    expect(tts?.closed).toBe(true);
    expect(asr?.closed).toBe(true);
  });
});
