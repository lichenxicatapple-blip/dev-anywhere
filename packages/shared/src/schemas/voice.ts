import { z } from "zod";

export const voiceProviderValues = ["aliyun-bailian"] as const;
export const voiceRegionValues = ["cn", "intl"] as const;
export const voiceOptionSourceValues = ["official", "custom"] as const;
export const voiceOptionGenderValues = ["male", "female", "unknown"] as const;

export const VoiceProviderConfigSchema = z
  .object({
    provider: z.enum(voiceProviderValues),
    configured: z.boolean(),
    region: z.enum(voiceRegionValues),
    asrModel: z.string().min(1),
    ttsModel: z.string().min(1),
    ttsVoice: z.string().min(1),
    turnIdleSeconds: z.number().int().positive().safe().default(3),
  })
  .strict();
export type VoiceProviderConfig = z.infer<typeof VoiceProviderConfigSchema>;

export const VoiceConfigUpdateSchema = z
  .object({
    provider: z.enum(voiceProviderValues).optional(),
    apiKey: z.string().min(1).optional(),
    clearApiKey: z.boolean().optional(),
    region: z.enum(voiceRegionValues).optional(),
    asrModel: z.string().min(1).optional(),
    ttsModel: z.string().min(1).optional(),
    ttsVoice: z.string().min(1).optional(),
    turnIdleSeconds: z.number().int().positive().safe().optional(),
  })
  .strict();
export type VoiceConfigUpdate = z.infer<typeof VoiceConfigUpdateSchema>;

export const VoiceOptionSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    gender: z.enum(voiceOptionGenderValues).optional(),
    age: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    source: z.enum(voiceOptionSourceValues),
  })
  .strict();
export type VoiceOption = z.infer<typeof VoiceOptionSchema>;

export const VoiceCapabilitiesSchema = z
  .object({
    asrModels: z.array(VoiceOptionSchema),
    ttsModels: z.array(VoiceOptionSchema),
    ttsVoices: z.array(VoiceOptionSchema),
    fetchedAt: z.number().optional(),
  })
  .strict();
export type VoiceCapabilities = z.infer<typeof VoiceCapabilitiesSchema>;

// Official snapshot from Alibaba Cloud Bailian docs, captured 2026-05-18.
// Alibaba does not currently expose a clean API-key-scoped catalog endpoint for these system models.
const BUNDLED_BAILIAN_ASR_MODELS: VoiceOption[] = [
  {
    value: "qwen3-asr-flash-realtime",
    label: "Qwen3 ASR Flash Realtime",
    source: "official",
  },
  {
    value: "qwen3-asr-flash-realtime-2026-02-10",
    label: "Qwen3 ASR Flash Realtime · 2026-02-10",
    source: "official",
  },
  {
    value: "qwen3-asr-flash-realtime-2025-10-27",
    label: "Qwen3 ASR Flash Realtime · 2025-10-27",
    source: "official",
  },
];

const BUNDLED_BAILIAN_TTS_MODELS: VoiceOption[] = [
  {
    value: "cosyvoice-v3-flash",
    label: "CosyVoice V3 Flash · 系统音色",
    source: "official",
  },
  {
    value: "cosyvoice-v3-plus",
    label: "CosyVoice V3 Plus · 系统音色",
    source: "official",
  },
  {
    value: "cosyvoice-v3.5-flash",
    label: "CosyVoice V3.5 Flash · 自定义音色",
    source: "official",
  },
  {
    value: "cosyvoice-v3.5-plus",
    label: "CosyVoice V3.5 Plus · 自定义音色",
    source: "official",
  },
];

const BUNDLED_BAILIAN_TTS_VOICES: VoiceOption[] = [
  {
    value: "longanyang",
    label: "龙安洋 · 男 · 阳光大男孩 · 年龄 20-30",
    gender: "male",
    age: "20-30",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longanhuan",
    label: "龙安欢 · 女 · 欢脱元气 · 年龄 20-30",
    gender: "female",
    age: "20-30",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longhuhu_v3",
    label: "龙呼呼 · 女 · 天真烂漫女童 · 年龄 6-10",
    gender: "female",
    age: "6-10",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longpaopao_v3",
    label: "龙泡泡 · 未知 · 飞天泡泡音 · 年龄 6-15",
    gender: "unknown",
    age: "6-15",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longjielidou_v3",
    label: "龙杰力豆 · 男 · 阳光顽皮 · 年龄 10",
    gender: "male",
    age: "10",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longxian_v3",
    label: "龙仙 · 女 · 豪放可爱 · 年龄 12",
    gender: "female",
    age: "12",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longling_v3",
    label: "龙铃 · 女 · 稚气呆板 · 年龄 10",
    gender: "female",
    age: "10",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longjiaxin_v3",
    label: "龙嘉欣 · 女 · 优雅粤语 · 年龄 30-35",
    gender: "female",
    age: "30-35",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longanyue_v3",
    label: "龙安粤 · 男 · 欢脱粤语 · 年龄 25-35",
    gender: "male",
    age: "25-35",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longlaotie_v3",
    label: "龙老铁 · 男 · 东北直率 · 年龄 25-30",
    gender: "male",
    age: "25-30",
    model: "cosyvoice-v3-flash",
    source: "official",
  },
  {
    value: "longanyang",
    label: "龙安洋 · 男 · 阳光大男孩 · 年龄 20-30",
    gender: "male",
    age: "20-30",
    model: "cosyvoice-v3-plus",
    source: "official",
  },
  {
    value: "longanhuan",
    label: "龙安欢 · 女 · 欢脱元气 · 年龄 20-30",
    gender: "female",
    age: "20-30",
    model: "cosyvoice-v3-plus",
    source: "official",
  },
];

function cloneVoiceOption(option: VoiceOption): VoiceOption {
  return { ...option };
}

export function createBundledBailianVoiceCapabilities(fetchedAt?: number): VoiceCapabilities {
  return {
    asrModels: BUNDLED_BAILIAN_ASR_MODELS.map(cloneVoiceOption),
    ttsModels: BUNDLED_BAILIAN_TTS_MODELS.map(cloneVoiceOption),
    ttsVoices: BUNDLED_BAILIAN_TTS_VOICES.map(cloneVoiceOption),
    ...(typeof fetchedAt === "number" ? { fetchedAt } : {}),
  };
}

export const VoiceSummaryReasonSchema = z.enum([
  "code",
  "table",
  "diff",
  "log",
  "stack_trace",
  "long_list",
  "long_text",
  "mixed",
  "approval",
]);
export type VoiceSummaryReason = z.infer<typeof VoiceSummaryReasonSchema>;
