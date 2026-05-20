import { describe, expect, it } from "vitest";
import {
  VoiceConfigUpdateSchema,
  VoiceProviderConfigSchema,
  createBundledBailianVoiceCapabilities,
  voiceProviderValues,
  voiceRegionValues,
} from "../voice.js";

describe("VoiceProviderConfigSchema", () => {
  it("accepts a redacted Bailian voice config response", () => {
    expect(
      VoiceProviderConfigSchema.parse({
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 5,
      }),
    ).toEqual({
      provider: "aliyun-bailian",
      configured: true,
      region: "cn",
      asrModel: "qwen3-asr-flash-realtime",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
      turnIdleSeconds: 5,
    });
  });

  it("defaults the voice turn idle timeout for older config responses", () => {
    expect(
      VoiceProviderConfigSchema.parse({
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
      }).turnIdleSeconds,
    ).toBe(3);
  });

  it("rejects API keys in config responses", () => {
    expect(() =>
      VoiceProviderConfigSchema.parse({
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        apiKey: "sk-secret",
      }),
    ).toThrow();
  });
});

describe("VoiceConfigUpdateSchema", () => {
  it("accepts write-only API key updates", () => {
    expect(
      VoiceConfigUpdateSchema.parse({
        provider: "aliyun-bailian",
        apiKey: "sk-secret",
        region: "intl",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 5,
      }),
    ).toMatchObject({
      provider: "aliyun-bailian",
      apiKey: "sk-secret",
      region: "intl",
      turnIdleSeconds: 5,
    });
  });

  it("rejects empty optional update strings", () => {
    expect(() => VoiceConfigUpdateSchema.parse({ apiKey: "" })).toThrow();
    expect(() => VoiceConfigUpdateSchema.parse({ asrModel: "" })).toThrow();
    expect(() => VoiceConfigUpdateSchema.parse({ ttsVoice: "" })).toThrow();
  });

  it("rejects invalid voice turn idle timeout updates", () => {
    expect(() => VoiceConfigUpdateSchema.parse({ turnIdleSeconds: 0 })).toThrow();
    expect(() => VoiceConfigUpdateSchema.parse({ turnIdleSeconds: 1.5 })).toThrow();
    expect(() => VoiceConfigUpdateSchema.parse({ turnIdleSeconds: "3" })).toThrow();
  });
});

describe("voice constants", () => {
  it("exports provider and region values for UI controls", () => {
    expect(voiceProviderValues).toEqual(["aliyun-bailian"]);
    expect(voiceRegionValues).toEqual(["cn", "intl"]);
  });

  it("exports bundled Bailian voice capabilities for offline UI fallback", () => {
    const capabilities = createBundledBailianVoiceCapabilities(1760000000000);

    expect(capabilities.fetchedAt).toBe(1760000000000);
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
