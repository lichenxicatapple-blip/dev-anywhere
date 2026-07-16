import { WebSocket, type RawData } from "ws";
import {
  VoiceAsrClientMessageSchema,
  decodeMuLawToPcm16,
  type VoiceAsrStartMessage,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { BailianAsrClient, BailianAsrConfig } from "./bailian-asr.js";
import type { StoredVoiceConfig, VoiceConfigStore } from "./config-store.js";
import type { VoiceAsrProviderClient, VoiceProviderRegistry } from "./provider.js";

export type VoiceAsrClientFactory = (config: BailianAsrConfig) => BailianAsrClient;

interface ActiveAsrStats {
  sessionId: string;
  attemptId: string;
  sampleRate: number;
  provider: StoredVoiceConfig["provider"];
  region: StoredVoiceConfig["region"];
  asrModel: string;
  encoding: VoiceAsrStartMessage["encoding"];
  startedAt: number;
  readyAt: number | null;
  firstPcmAt: number | null;
  encodedBytes: number;
  pcmBytes: number;
  pcmChunks: number;
  partialEvents: number;
  finalEvents: number;
  finalChars: number;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function parseJson(data: RawData): unknown | null {
  try {
    return JSON.parse(toBuffer(data).toString("utf8"));
  } catch {
    return null;
  }
}

function buildStats(payload: VoiceAsrStartMessage, config: StoredVoiceConfig): ActiveAsrStats {
  return {
    sessionId: payload.sessionId,
    attemptId: payload.attemptId,
    sampleRate: payload.sampleRate,
    provider: config.provider,
    region: config.region,
    asrModel: config.asrModel,
    encoding: payload.encoding,
    startedAt: Date.now(),
    readyAt: null,
    firstPcmAt: null,
    encodedBytes: 0,
    pcmBytes: 0,
    pcmChunks: 0,
    partialEvents: 0,
    finalEvents: 0,
    finalChars: 0,
  };
}

function statsLogFields(stats: ActiveAsrStats): Record<string, unknown> {
  const now = Date.now();
  return {
    sessionId: stats.sessionId,
    attemptId: stats.attemptId,
    sampleRate: stats.sampleRate,
    provider: stats.provider,
    region: stats.region,
    asrModel: stats.asrModel,
    encoding: stats.encoding,
    encodedBytes: stats.encodedBytes,
    pcmBytes: stats.pcmBytes,
    pcmChunks: stats.pcmChunks,
    partialEvents: stats.partialEvents,
    finalEvents: stats.finalEvents,
    finalChars: stats.finalChars,
    durationMs: now - stats.startedAt,
    readyMs: stats.readyAt === null ? null : stats.readyAt - stats.startedAt,
    firstPcmMs: stats.firstPcmAt === null ? null : stats.firstPcmAt - stats.startedAt,
  };
}

export function handleVoiceAsrConnection(
  ws: WebSocket,
  store: VoiceConfigStore,
  logger: Logger,
  providers: VoiceProviderRegistry,
): void {
  let provider: VoiceAsrProviderClient | null = null;
  let activeStats: ActiveAsrStats | null = null;

  function isCurrent(
    candidate: VoiceAsrProviderClient,
    stats: ActiveAsrStats,
    event: string,
  ): boolean {
    if (provider === candidate && activeStats === stats) return true;
    logger.debug(
      { attemptId: stats.attemptId, activeAttemptId: activeStats?.attemptId ?? null, event },
      "Ignored stale Voice ASR provider event",
    );
    return false;
  }

  function detachProvider(reason: string): void {
    const previousProvider = provider;
    const previousStats = activeStats;
    provider = null;
    activeStats = null;
    if (previousStats) {
      logger.info({ ...statsLogFields(previousStats), reason }, "Voice ASR attempt detached");
    }
    previousProvider?.close();
  }

  function start(payload: VoiceAsrStartMessage): void {
    const config = store.readSecret();
    if (!config.apiKey) {
      sendJson(ws, {
        type: "error",
        attemptId: payload.attemptId,
        errorCode: "not_configured",
        error: "Voice provider is not configured",
      });
      return;
    }
    detachProvider("replaced");
    const stats = buildStats(payload, config);
    let currentProvider: VoiceAsrProviderClient;
    try {
      currentProvider = providers.current(config).createAsrClient(config, {
        sampleRate: stats.sampleRate,
        language: "zh",
      });
    } catch (error) {
      logger.warn({ ...statsLogFields(stats), err: error }, "Voice ASR provider creation failed");
      sendJson(ws, {
        type: "error",
        attemptId: payload.attemptId,
        error: error instanceof Error ? error.message : "ASR failed",
      });
      return;
    }
    provider = currentProvider;
    activeStats = stats;
    logger.info(statsLogFields(stats), "Voice ASR attempt started");
    currentProvider.on("ready", () => {
      if (!isCurrent(currentProvider, stats, "ready")) return;
      stats.readyAt = Date.now();
      logger.info(statsLogFields(stats), "Voice ASR provider ready");
      sendJson(ws, { type: "ready", attemptId: stats.attemptId });
    });
    currentProvider.on("partial", (text) => {
      if (!isCurrent(currentProvider, stats, "partial")) return;
      stats.partialEvents += 1;
      sendJson(ws, { type: "partial", attemptId: stats.attemptId, text });
    });
    currentProvider.on("final", (text) => {
      if (!isCurrent(currentProvider, stats, "final")) return;
      stats.finalEvents += 1;
      stats.finalChars += text.length;
      sendJson(ws, { type: "final", attemptId: stats.attemptId, text });
    });
    currentProvider.on("error", (error) => {
      if (!isCurrent(currentProvider, stats, "error")) return;
      logger.warn({ ...statsLogFields(stats), err: error }, "Voice ASR provider reported an error");
      sendJson(ws, {
        type: "error",
        attemptId: stats.attemptId,
        error: error.message || "ASR failed",
      });
    });
    currentProvider.on("closed", (code, reason) => {
      if (!isCurrent(currentProvider, stats, "closed")) return;
      provider = null;
      activeStats = null;
      logger.info({ ...statsLogFields(stats), code, reason }, "Voice ASR provider closed");
      sendJson(ws, { type: "closed", attemptId: stats.attemptId, code, reason });
    });
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const encodedChunk = toBuffer(data);
      if (provider && activeStats) {
        const pcmChunk =
          activeStats.encoding === "mulaw"
            ? Buffer.from(decodeMuLawToPcm16(encodedChunk))
            : encodedChunk;
        if (activeStats.firstPcmAt === null) activeStats.firstPcmAt = Date.now();
        activeStats.encodedBytes += encodedChunk.byteLength;
        activeStats.pcmBytes += pcmChunk.byteLength;
        activeStats.pcmChunks += 1;
        provider.sendPcm(pcmChunk);
        sendJson(ws, {
          type: "audio_ack",
          attemptId: activeStats.attemptId,
          encodedBytes: activeStats.encodedBytes,
          pcmBytes: activeStats.pcmBytes,
          chunks: activeStats.pcmChunks,
        });
      }
      return;
    }

    const parsed = VoiceAsrClientMessageSchema.safeParse(parseJson(data));
    if (!parsed.success) {
      logger.debug({ issues: parsed.error.issues }, "Ignored invalid Voice ASR client message");
      return;
    }
    const payload = parsed.data;
    if (payload.type === "start") {
      start(payload);
      return;
    }
    if (payload.type === "stop") {
      if (!provider || !activeStats || activeStats.attemptId !== payload.attemptId) {
        logger.debug(
          { attemptId: payload.attemptId, activeAttemptId: activeStats?.attemptId ?? null },
          "Ignored stale Voice ASR stop",
        );
        return;
      }
      logger.info(statsLogFields(activeStats), "Voice ASR stop requested");
      provider.stop();
    }
  });

  ws.on("close", (code, reason) => {
    if (activeStats) {
      logger.info(
        { ...statsLogFields(activeStats), code, reason: reason.toString("utf8") },
        "Voice ASR client websocket closed",
      );
    }
    detachProvider("client-websocket-closed");
  });
  ws.on("error", (err) => {
    logger.warn(
      { ...(activeStats ? statsLogFields(activeStats) : {}), err },
      "Voice ASR websocket error",
    );
    detachProvider("client-websocket-error");
  });
}
