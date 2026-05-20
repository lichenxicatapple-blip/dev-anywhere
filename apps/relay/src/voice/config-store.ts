import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VoiceConfigUpdateSchema,
  VoiceProviderConfigSchema,
  type VoiceConfigUpdate,
  type VoiceProviderConfig,
} from "@dev-anywhere/shared";

export interface StoredVoiceConfig {
  provider: "aliyun-bailian";
  apiKey?: string;
  region: "cn" | "intl";
  asrModel: string;
  ttsModel: string;
  ttsVoice: string;
  turnIdleSeconds: number;
}

interface VoiceConfigStoreOptions {
  dataDir?: string;
  defaults?: Partial<Omit<StoredVoiceConfig, "provider" | "apiKey">>;
}

export interface VoiceConfigStore {
  read: () => VoiceProviderConfig;
  update: (update: VoiceConfigUpdate) => VoiceProviderConfig;
  readSecret: () => StoredVoiceConfig;
}

const DEFAULT_STORED_CONFIG: StoredVoiceConfig = {
  provider: "aliyun-bailian",
  region: "cn",
  asrModel: "qwen3-asr-flash-realtime",
  ttsModel: "cosyvoice-v3-flash",
  ttsVoice: "longanyang",
  turnIdleSeconds: 3,
};

function redacted(config: StoredVoiceConfig): VoiceProviderConfig {
  return VoiceProviderConfigSchema.parse({
    provider: config.provider,
    configured: Boolean(config.apiKey),
    region: config.region,
    asrModel: config.asrModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    turnIdleSeconds: config.turnIdleSeconds,
  });
}

function mergeDefaults(defaults: VoiceConfigStoreOptions["defaults"]): StoredVoiceConfig {
  return {
    ...DEFAULT_STORED_CONFIG,
    ...defaults,
  };
}

function parseStoredConfig(raw: unknown, fallback: StoredVoiceConfig): StoredVoiceConfig {
  if (!raw || typeof raw !== "object") return fallback;
  const candidate = raw as Partial<StoredVoiceConfig>;
  return {
    ...fallback,
    provider: "aliyun-bailian",
    ...(typeof candidate.apiKey === "string" && candidate.apiKey.length > 0
      ? { apiKey: candidate.apiKey }
      : { apiKey: undefined }),
    ...(candidate.region === "cn" || candidate.region === "intl"
      ? { region: candidate.region }
      : {}),
    ...(typeof candidate.asrModel === "string" && candidate.asrModel.length > 0
      ? { asrModel: candidate.asrModel }
      : {}),
    ...(typeof candidate.ttsModel === "string" && candidate.ttsModel.length > 0
      ? { ttsModel: candidate.ttsModel }
      : {}),
    ...(typeof candidate.ttsVoice === "string" && candidate.ttsVoice.length > 0
      ? { ttsVoice: candidate.ttsVoice }
      : {}),
    ...(typeof candidate.turnIdleSeconds === "number" &&
    Number.isSafeInteger(candidate.turnIdleSeconds) &&
    candidate.turnIdleSeconds > 0
      ? { turnIdleSeconds: candidate.turnIdleSeconds }
      : {}),
  };
}

export function createVoiceConfigStore(options: VoiceConfigStoreOptions = {}): VoiceConfigStore {
  const fallback = mergeDefaults(options.defaults);
  const filePath = options.dataDir ? join(options.dataDir, "voice-config.json") : null;
  let memoryConfig: StoredVoiceConfig = fallback;

  function load(): StoredVoiceConfig {
    if (!filePath) return memoryConfig;
    if (!existsSync(filePath)) return fallback;
    try {
      return parseStoredConfig(JSON.parse(readFileSync(filePath, "utf8")), fallback);
    } catch {
      return fallback;
    }
  }

  function save(config: StoredVoiceConfig): void {
    if (!filePath) {
      memoryConfig = config;
      return;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    read() {
      return redacted(load());
    },
    update(update) {
      const parsed = VoiceConfigUpdateSchema.parse(update);
      const current = load();
      const next: StoredVoiceConfig = {
        ...current,
        provider: "aliyun-bailian",
        ...(parsed.clearApiKey ? { apiKey: undefined } : {}),
        ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
        ...(parsed.region ? { region: parsed.region } : {}),
        ...(parsed.asrModel ? { asrModel: parsed.asrModel } : {}),
        ...(parsed.ttsModel ? { ttsModel: parsed.ttsModel } : {}),
        ...(parsed.ttsVoice ? { ttsVoice: parsed.ttsVoice } : {}),
        ...(parsed.turnIdleSeconds ? { turnIdleSeconds: parsed.turnIdleSeconds } : {}),
      };
      save(next);
      return redacted(next);
    },
    readSecret() {
      return load();
    },
  };
}
