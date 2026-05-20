import type { VoiceConfigUpdate } from "@dev-anywhere/shared";
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
import type { StoredVoiceConfig } from "./config-store.js";

export interface VoiceConfigTestResult {
  audio?: Buffer;
  sampleRate?: number;
  transcript?: string;
}

export interface VoiceConfigTester {
  test: (config: StoredVoiceConfig) => Promise<VoiceConfigTestResult>;
}

interface BailianVoiceConfigTesterOptions {
  ttsClientFactory?: (config: BailianTtsConfig) => BailianTtsClient;
  asrClientFactory?: (config: BailianAsrConfig) => BailianAsrClient;
  sampleText?: string;
  timeoutMs?: number;
}

const TEST_SAMPLE_RATE = 16000;
const ASR_TEST_CHUNK_BYTES = 3200;
const ASR_TEST_CHUNK_INTERVAL_MS = 100;

export function mergeVoiceConfigForTest(
  current: StoredVoiceConfig,
  update?: VoiceConfigUpdate,
): StoredVoiceConfig {
  return {
    ...current,
    provider: "aliyun-bailian",
    ...(update?.clearApiKey ? { apiKey: undefined } : {}),
    ...(update?.apiKey ? { apiKey: update.apiKey } : {}),
    ...(update?.region ? { region: update.region } : {}),
    ...(update?.asrModel ? { asrModel: update.asrModel } : {}),
    ...(update?.ttsModel ? { ttsModel: update.ttsModel } : {}),
    ...(update?.ttsVoice ? { ttsVoice: update.ttsVoice } : {}),
    ...(update?.turnIdleSeconds ? { turnIdleSeconds: update.turnIdleSeconds } : {}),
  };
}

export function createBailianVoiceConfigTester(
  options: BailianVoiceConfigTesterOptions = {},
): VoiceConfigTester {
  const ttsClientFactory = options.ttsClientFactory ?? createBailianTtsClient;
  const asrClientFactory = options.asrClientFactory ?? createBailianAsrClient;
  const sampleText = options.sampleText ?? "语音助手测试";
  const timeoutMs = options.timeoutMs ?? 8000;

  return {
    async test(config) {
      if (!config.apiKey) {
        return Promise.reject(new Error("请先填写阿里云百炼 API Key"));
      }
      const audio = await synthesizeTestAudio({
        config,
        sampleText,
        timeoutMs,
        clientFactory: ttsClientFactory,
      });
      const transcript = await recognizeTestAudio({
        config,
        audio,
        sampleText,
        timeoutMs,
        clientFactory: asrClientFactory,
      });
      return { audio, sampleRate: TEST_SAMPLE_RATE, transcript };
    },
  };
}

function synthesizeTestAudio(options: {
  config: StoredVoiceConfig;
  sampleText: string;
  timeoutMs: number;
  clientFactory: (config: BailianTtsConfig) => BailianTtsClient;
}): Promise<Buffer> {
  const { config, sampleText, timeoutMs, clientFactory } = options;
  const client = clientFactory({
    apiKey: config.apiKey!,
    region: config.region,
    model: config.ttsModel,
    voice: config.ttsVoice,
    sampleRate: TEST_SAMPLE_RATE,
  });

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      settle(new Error("TTS 测试超时"));
    }, timeoutMs);

    function settle(error?: Error, audio?: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      if (error) reject(error);
      else resolve(audio ?? Buffer.alloc(0));
    }

    client.on("audio", (chunk) => {
      if (chunk.length > 0) chunks.push(chunk);
    });
    client.on("finished", () => {
      if (chunks.length === 0) {
        settle(new Error("TTS 测试没有返回音频"));
        return;
      }
      settle(undefined, Buffer.concat(chunks));
    });
    client.on("error", (error) => settle(error));
    client.on("closed", () => {
      if (!settled) settle(new Error("TTS 测试连接已关闭"));
    });

    try {
      client.speak(sampleText);
    } catch (err) {
      settle(err instanceof Error ? err : new Error("TTS 测试启动失败"));
    }
  });
}

function recognizeTestAudio(options: {
  config: StoredVoiceConfig;
  audio: Buffer;
  sampleText: string;
  timeoutMs: number;
  clientFactory: (config: BailianAsrConfig) => BailianAsrClient;
}): Promise<string> {
  const { config, audio, sampleText, timeoutMs, clientFactory } = options;
  const client = clientFactory({
    apiKey: config.apiKey!,
    region: config.region,
    model: config.asrModel,
    sampleRate: TEST_SAMPLE_RATE,
    language: "zh",
  });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      settle(new Error("STT 测试超时"));
    }, timeoutMs);

    function settle(error?: Error, transcript?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (streamTimer) clearTimeout(streamTimer);
      client.close();
      if (error) reject(error);
      else resolve(transcript ?? "");
    }

    client.on("ready", () => {
      let offset = 0;
      const sendNextChunk = () => {
        if (settled) return;
        const chunk = audio.subarray(offset, offset + ASR_TEST_CHUNK_BYTES);
        if (chunk.length > 0) {
          client.sendPcm(chunk);
          offset += chunk.length;
        }
        if (offset >= audio.length) {
          client.stop();
          return;
        }
        streamTimer = setTimeout(sendNextChunk, ASR_TEST_CHUNK_INTERVAL_MS);
      };
      sendNextChunk();
    });
    client.on("final", (transcript) => {
      if (matchesExpectedTranscript(transcript, sampleText)) {
        settle(undefined, transcript);
        return;
      }
      settle(new Error(`STT 测试识别结果不匹配：${transcript}`));
    });
    client.on("error", (error) => settle(error));
    client.on("closed", () => {
      if (!settled) settle(new Error("STT 测试连接已关闭"));
    });
  });
}

function matchesExpectedTranscript(actual: string, expected: string): boolean {
  return normalizeTranscript(actual).includes(normalizeTranscript(expected));
}

function normalizeTranscript(text: string): string {
  return text.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "").toLowerCase();
}
