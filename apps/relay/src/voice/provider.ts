import type { VoiceCapabilities, VoiceProviderConfig } from "@dev-anywhere/shared";
import type { StoredVoiceConfig } from "./config-store.js";
import type { VoiceConfigTestResult } from "./config-test.js";

export type VoiceProviderId = VoiceProviderConfig["provider"];

export interface VoiceAsrProviderClient {
  on(event: "ready", handler: () => void): this;
  on(event: "partial" | "final", handler: (text: string) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: "closed", handler: (code?: number, reason?: string) => void): this;
  sendPcm(chunk: Buffer): void;
  stop(): void;
  close(): void;
}

export interface VoiceTtsProviderClient {
  on(event: "started" | "finished", handler: () => void): this;
  on(event: "audio", handler: (chunk: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: "closed", handler: (code?: number, reason?: string) => void): this;
  speak(text: string): void;
  close(): void;
}

export interface VoiceAsrProviderOptions {
  sampleRate: number;
  language: string;
}

export interface VoiceTtsProviderOptions {
  sampleRate: number;
}

export interface VoiceProviderAdapter {
  id: VoiceProviderId;
  createAsrClient: (
    config: StoredVoiceConfig,
    options: VoiceAsrProviderOptions,
  ) => VoiceAsrProviderClient;
  createTtsClient: (
    config: StoredVoiceConfig,
    options: VoiceTtsProviderOptions,
  ) => VoiceTtsProviderClient;
  readCapabilities: (config: StoredVoiceConfig) => Promise<VoiceCapabilities>;
  testConfig: (config: StoredVoiceConfig) => Promise<VoiceConfigTestResult>;
}

export interface VoiceProviderRegistry {
  current: (config: StoredVoiceConfig) => VoiceProviderAdapter;
  require: (providerId: string) => VoiceProviderAdapter;
}

export function createVoiceProviderRegistry(
  adapters: readonly VoiceProviderAdapter[],
): VoiceProviderRegistry {
  const byId = new Map<string, VoiceProviderAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Duplicate voice provider: ${adapter.id}`);
    }
    byId.set(adapter.id, adapter);
  }

  function require(providerId: string): VoiceProviderAdapter {
    const adapter = byId.get(providerId);
    if (!adapter) throw new Error(`Unsupported voice provider: ${providerId}`);
    return adapter;
  }

  return {
    current(config) {
      return require(config.provider);
    },
    require,
  };
}
