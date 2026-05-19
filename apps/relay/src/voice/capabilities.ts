import {
  createBundledBailianVoiceCapabilities,
  type VoiceCapabilities,
  type VoiceOption,
} from "@dev-anywhere/shared";
import type { StoredVoiceConfig } from "./config-store.js";

type FetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};
type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponse>;

export interface VoiceCapabilitiesProvider {
  read: (config: StoredVoiceConfig) => Promise<VoiceCapabilities>;
}

interface BailianVoiceCapabilitiesProviderOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
}

const CUSTOMIZATION_ENDPOINTS: Record<StoredVoiceConfig["region"], string> = {
  cn: "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
  intl: "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization",
};

function modelFromCustomCosyVoiceId(voiceId: string): string | undefined {
  const match = voiceId.match(/^(cosyvoice-v3(?:\.5)?-(?:flash|plus))-/);
  return match?.[1];
}

async function fetchCustomVoices(
  fetchImpl: FetchLike,
  config: StoredVoiceConfig,
): Promise<VoiceOption[]> {
  if (!config.apiKey) return [];
  const response = await fetchImpl(CUSTOMIZATION_ENDPOINTS[config.region], {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voice-enrollment",
      input: {
        action: "list_voice",
        page_size: 100,
        page_index: 0,
      },
    }),
  });
  if (!response.ok) return [];
  const payload = response.json() as Promise<{
    output?: {
      voice_list?: Array<{
        voice_id?: string;
        status?: string;
        voice_prompt?: string;
      }>;
    };
  }>;
  const voiceList = (await payload).output?.voice_list ?? [];
  return voiceList
    .filter((voice) => !voice.status || voice.status === "OK")
    .flatMap((voice): VoiceOption[] => {
      if (!voice.voice_id) return [];
      const model = modelFromCustomCosyVoiceId(voice.voice_id);
      return [
        {
          value: voice.voice_id,
          label: [voice.voice_id, "自定义", voice.voice_prompt].filter(Boolean).join(" · "),
          ...(model ? { model } : {}),
          source: "custom",
        },
      ];
    });
}

export function createBailianVoiceCapabilitiesProvider(
  options: BailianVoiceCapabilitiesProviderOptions = {},
): VoiceCapabilitiesProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;

  return {
    async read(config) {
      let customVoices: VoiceOption[];
      try {
        customVoices = await fetchCustomVoices(fetchImpl, config);
      } catch {
        customVoices = [];
      }

      const bundled = createBundledBailianVoiceCapabilities(now());
      return {
        ...bundled,
        ttsVoices: [...bundled.ttsVoices, ...customVoices],
      };
    },
  };
}
