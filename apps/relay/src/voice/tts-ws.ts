import { WebSocket, type RawData } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { BailianTtsClient, BailianTtsConfig } from "./bailian-tts.js";
import type { StoredVoiceConfig, VoiceConfigStore } from "./config-store.js";
import type { VoiceProviderRegistry, VoiceTtsProviderClient } from "./provider.js";

export type VoiceTtsClientFactory = (config: BailianTtsConfig) => BailianTtsClient;

interface SpeakMessage {
  type: "speak";
  requestId: string;
  text: string;
}

interface ActiveTtsStats {
  requestId: string;
  textChars: number;
  provider: StoredVoiceConfig["provider"];
  region: StoredVoiceConfig["region"];
  ttsModel: string;
  ttsVoice: string;
  startedAt: number;
  firstAudioAt: number | null;
  audioBytes: number;
  audioChunks: number;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseJson(data: RawData): unknown | null {
  try {
    const buffer = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat(data);
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function isSpeakMessage(payload: unknown): payload is SpeakMessage {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return (
    record.type === "speak" &&
    typeof record.requestId === "string" &&
    typeof record.text === "string" &&
    record.text.length > 0
  );
}

function nowMs(): number {
  return Date.now();
}

function buildStats(requestId: string, text: string, config: StoredVoiceConfig): ActiveTtsStats {
  return {
    requestId,
    textChars: text.length,
    provider: config.provider,
    region: config.region,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    startedAt: nowMs(),
    firstAudioAt: null,
    audioBytes: 0,
    audioChunks: 0,
  };
}

function statsLogFields(stats: ActiveTtsStats): Record<string, unknown> {
  const currentTime = nowMs();
  return {
    requestId: stats.requestId,
    textChars: stats.textChars,
    provider: stats.provider,
    region: stats.region,
    ttsModel: stats.ttsModel,
    ttsVoice: stats.ttsVoice,
    audioBytes: stats.audioBytes,
    audioChunks: stats.audioChunks,
    durationMs: currentTime - stats.startedAt,
    firstAudioMs: stats.firstAudioAt === null ? null : stats.firstAudioAt - stats.startedAt,
  };
}

function closeReasonText(reason: unknown): string {
  if (Buffer.isBuffer(reason)) return reason.toString("utf8");
  return typeof reason === "string" ? reason : "";
}

export function handleVoiceTtsConnection(
  ws: WebSocket,
  store: VoiceConfigStore,
  logger: Logger,
  providers: VoiceProviderRegistry,
): void {
  let provider: VoiceTtsProviderClient | null = null;
  let providerConfig: StoredVoiceConfig | null = null;
  let activeRequestId: string | null = null;
  let activeStats: ActiveTtsStats | null = null;

  function ensureProvider(): { client: VoiceTtsProviderClient; config: StoredVoiceConfig } | null {
    if (provider && providerConfig) return { client: provider, config: providerConfig };
    const config = store.readSecret();
    if (!config.apiKey) {
      sendJson(ws, {
        type: "error",
        errorCode: "not_configured",
        error: "Voice provider is not configured",
      });
      return null;
    }
    provider = providers.current(config).createTtsClient(config, {
      sampleRate: 24000,
    });
    providerConfig = config;
    provider.on("started", () => {
      if (activeStats) logger.info(statsLogFields(activeStats), "Voice TTS started");
      sendJson(ws, { type: "started", requestId: activeRequestId });
    });
    provider.on("audio", (chunk) => {
      if (activeStats) {
        if (activeStats.firstAudioAt === null) activeStats.firstAudioAt = nowMs();
        activeStats.audioBytes += chunk.byteLength;
        activeStats.audioChunks += 1;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    provider.on("finished", () => {
      if (activeStats) logger.info(statsLogFields(activeStats), "Voice TTS finished");
      sendJson(ws, { type: "finished", requestId: activeRequestId });
      activeRequestId = null;
      activeStats = null;
    });
    provider.on("error", (error) => {
      if (activeStats) {
        logger.warn(
          { ...statsLogFields(activeStats), err: error },
          "Voice TTS provider reported an error",
        );
      }
      sendJson(ws, {
        type: "error",
        requestId: activeRequestId,
        error: error.message || "TTS failed",
      });
      activeRequestId = null;
      activeStats = null;
    });
    provider.on("closed", (code, reason) => {
      if (activeStats) {
        logger.warn(
          { ...statsLogFields(activeStats), code, reason },
          "Voice TTS provider closed before finishing",
        );
        sendJson(ws, {
          type: "error",
          requestId: activeRequestId,
          errorCode: "provider_closed",
          error: "Voice TTS provider closed before finishing",
        });
        activeRequestId = null;
        activeStats = null;
      } else {
        logger.info({ code, reason }, "Voice TTS provider closed");
        provider = null;
        providerConfig = null;
        return;
      }
      sendJson(ws, { type: "closed", code, reason });
      provider = null;
      providerConfig = null;
    });
    return { client: provider, config };
  }

  ws.on("message", (data) => {
    const payload = parseJson(data);
    if (!isSpeakMessage(payload)) return;
    if (activeRequestId) {
      sendJson(ws, {
        type: "error",
        requestId: payload.requestId,
        errorCode: "busy",
        error: "Voice TTS is already speaking",
      });
      return;
    }
    const ensured = ensureProvider();
    if (!ensured) return;
    const { client, config } = ensured;
    activeRequestId = payload.requestId;
    activeStats = buildStats(payload.requestId, payload.text, config);
    logger.info(statsLogFields(activeStats), "Voice TTS request received");
    try {
      client.speak(payload.text);
    } catch (err) {
      if (activeStats) {
        logger.warn(
          { ...statsLogFields(activeStats), err },
          "Voice TTS request failed before provider accepted it",
        );
      }
      sendJson(ws, {
        type: "error",
        requestId: payload.requestId,
        error: err instanceof Error ? err.message : "Voice TTS failed",
      });
      activeRequestId = null;
      activeStats = null;
    }
  });

  ws.on("close", (code?: number, reason?: Buffer) => {
    if (activeStats) {
      logger.warn(
        { ...statsLogFields(activeStats), code, reason: closeReasonText(reason) },
        "Voice TTS client websocket closed before finishing",
      );
    }
    const currentProvider = provider;
    provider = null;
    providerConfig = null;
    activeRequestId = null;
    activeStats = null;
    currentProvider?.close();
  });
  ws.on("error", (err) => {
    logger.warn({ err }, "Voice TTS websocket error");
    provider?.close();
    provider = null;
    providerConfig = null;
    activeRequestId = null;
    activeStats = null;
  });
}
