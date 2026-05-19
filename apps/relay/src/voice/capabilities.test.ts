import { describe, expect, it, vi } from "vitest";
import { createBailianVoiceCapabilitiesProvider } from "./capabilities.js";

describe("Bailian voice capabilities provider", () => {
  it("returns bundled official ASR, TTS, and voice options when no API key is configured", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      throw new Error(`unexpected URL ${url}`);
    });
    const provider = createBailianVoiceCapabilitiesProvider({
      fetchImpl,
      now: () => 1760000000000,
    });

    const capabilities = await provider.read({
      provider: "aliyun-bailian",
      region: "cn",
      asrModel: "ignored-asr",
      ttsModel: "ignored-tts",
      ttsVoice: "ignored-voice",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(capabilities.asrModels).toContainEqual({
      value: "qwen3-asr-flash-realtime",
      label: "Qwen3 ASR Flash Realtime",
      source: "official",
    });
    expect(capabilities.ttsModels).toContainEqual({
      value: "cosyvoice-v3-flash",
      label: "CosyVoice V3 Flash · 系统音色",
      source: "official",
    });
    expect(capabilities.ttsModels).toContainEqual({
      value: "cosyvoice-v3.5-plus",
      label: "CosyVoice V3.5 Plus · 自定义音色",
      source: "official",
    });
    expect(capabilities.ttsVoices).toContainEqual({
      value: "longanyang",
      label: "龙安洋 · 男 · 阳光大男孩 · 年龄 20-30",
      gender: "male",
      age: "20-30",
      model: "cosyvoice-v3-flash",
      source: "official",
    });
    expect(capabilities.ttsVoices).toContainEqual({
      value: "longanhuan",
      label: "龙安欢 · 女 · 欢脱元气 · 年龄 20-30",
      gender: "female",
      age: "20-30",
      model: "cosyvoice-v3-plus",
      source: "official",
    });
    expect(capabilities.fetchedAt).toBe(1760000000000);
  });

  it("adds user-created CosyVoice voices from Bailian when an API key exists", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "voice-enrollment",
        input: { action: "list_voice" },
      });
      return Response.json({
        output: {
          voice_list: [
            {
              voice_id: "cosyvoice-v3-flash-vd-bedtime-abc123",
              status: "OK",
              voice_prompt: "温柔的女性睡前语音助手",
            },
            {
              voice_id: "cosyvoice-v3.5-plus-vd-review-abc123",
              status: "OK",
              voice_prompt: "沉稳的代码审查助手",
            },
            {
              voice_id: "cosyvoice-v3.5-plus-myvoice-abc123",
              status: "OK",
              voice_prompt: "复刻的代码审查助手",
            },
          ],
        },
      });
    });
    const provider = createBailianVoiceCapabilitiesProvider({ fetchImpl });

    const capabilities = await provider.read({
      provider: "aliyun-bailian",
      apiKey: "sk-test",
      region: "cn",
      asrModel: "ignored-asr",
      ttsModel: "ignored-tts",
      ttsVoice: "ignored-voice",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capabilities.ttsVoices).toContainEqual({
      value: "cosyvoice-v3-flash-vd-bedtime-abc123",
      label: "cosyvoice-v3-flash-vd-bedtime-abc123 · 自定义 · 温柔的女性睡前语音助手",
      model: "cosyvoice-v3-flash",
      source: "custom",
    });
    expect(capabilities.ttsVoices).toContainEqual({
      value: "cosyvoice-v3.5-plus-vd-review-abc123",
      label: "cosyvoice-v3.5-plus-vd-review-abc123 · 自定义 · 沉稳的代码审查助手",
      model: "cosyvoice-v3.5-plus",
      source: "custom",
    });
    expect(capabilities.ttsVoices).toContainEqual({
      value: "cosyvoice-v3.5-plus-myvoice-abc123",
      label: "cosyvoice-v3.5-plus-myvoice-abc123 · 自定义 · 复刻的代码审查助手",
      model: "cosyvoice-v3.5-plus",
      source: "custom",
    });
  });

  it("keeps bundled official choices when the custom voice API is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const provider = createBailianVoiceCapabilitiesProvider({
      fetchImpl,
      now: () => 1760000000000,
    });

    const capabilities = await provider.read({
      provider: "aliyun-bailian",
      apiKey: "sk-test",
      region: "cn",
      asrModel: "ignored-asr",
      ttsModel: "ignored-tts",
      ttsVoice: "ignored-voice",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capabilities.ttsModels.length).toBeGreaterThan(0);
    expect(capabilities.ttsVoices).toContainEqual({
      value: "longanyang",
      label: "龙安洋 · 男 · 阳光大男孩 · 年龄 20-30",
      gender: "male",
      age: "20-30",
      model: "cosyvoice-v3-flash",
      source: "official",
    });
  });
});
