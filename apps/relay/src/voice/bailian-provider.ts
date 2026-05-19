import {
  createBailianAsrClient,
  type BailianAsrClient,
  type BailianAsrConfig,
} from "./bailian-asr.js";
import {
  createBailianTtsClient,
  type BailianTtsClient,
  type BailianTtsConfig,
} from "./bailian-tts.js";
import {
  createBailianVoiceCapabilitiesProvider,
  type VoiceCapabilitiesProvider,
} from "./capabilities.js";
import { createBailianVoiceConfigTester, type VoiceConfigTester } from "./config-test.js";
import type { StoredVoiceConfig } from "./config-store.js";
import type { VoiceProviderAdapter } from "./provider.js";

export interface BailianVoiceProviderOptions {
  asrClientFactory?: (config: BailianAsrConfig) => BailianAsrClient;
  ttsClientFactory?: (config: BailianTtsConfig) => BailianTtsClient;
  capabilitiesProvider?: VoiceCapabilitiesProvider;
  configTester?: VoiceConfigTester;
}

function requireApiKey(config: StoredVoiceConfig): string {
  if (!config.apiKey) throw new Error("Voice provider is not configured");
  return config.apiKey;
}

export function createBailianVoiceProvider(
  options: BailianVoiceProviderOptions = {},
): VoiceProviderAdapter {
  const asrClientFactory = options.asrClientFactory ?? createBailianAsrClient;
  const ttsClientFactory = options.ttsClientFactory ?? createBailianTtsClient;
  const capabilitiesProvider =
    options.capabilitiesProvider ?? createBailianVoiceCapabilitiesProvider();
  const configTester =
    options.configTester ??
    createBailianVoiceConfigTester({
      asrClientFactory,
      ttsClientFactory,
    });

  return {
    id: "aliyun-bailian",
    createAsrClient(config, clientOptions) {
      return asrClientFactory({
        apiKey: requireApiKey(config),
        region: config.region,
        model: config.asrModel,
        sampleRate: clientOptions.sampleRate,
        language: clientOptions.language,
      });
    },
    createTtsClient(config, clientOptions) {
      return ttsClientFactory({
        apiKey: requireApiKey(config),
        region: config.region,
        model: config.ttsModel,
        voice: config.ttsVoice,
        sampleRate: clientOptions.sampleRate,
      });
    },
    readCapabilities(config) {
      return capabilitiesProvider.read(config);
    },
    testConfig(config) {
      return configTester.test(config);
    },
  };
}
