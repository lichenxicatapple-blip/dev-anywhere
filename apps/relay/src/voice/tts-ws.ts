import { WebSocket, type RawData } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { BailianTtsClient, BailianTtsConfig } from "./bailian-tts.js";
import type { VoiceConfigStore } from "./config-store.js";
import type { VoiceProviderRegistry, VoiceTtsProviderClient } from "./provider.js";

export type VoiceTtsClientFactory = (config: BailianTtsConfig) => BailianTtsClient;

interface SpeakMessage {
  type: "speak";
  requestId: string;
  text: string;
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

export function handleVoiceTtsConnection(
  ws: WebSocket,
  store: VoiceConfigStore,
  logger: Logger,
  providers: VoiceProviderRegistry,
): void {
  let provider: VoiceTtsProviderClient | null = null;
  let activeRequestId: string | null = null;

  function ensureProvider(): VoiceTtsProviderClient | null {
    if (provider) return provider;
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
    provider.on("started", () => sendJson(ws, { type: "started", requestId: activeRequestId }));
    provider.on("audio", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    provider.on("finished", () => {
      sendJson(ws, { type: "finished", requestId: activeRequestId });
      activeRequestId = null;
    });
    provider.on("error", (error) => {
      sendJson(ws, {
        type: "error",
        requestId: activeRequestId,
        error: error.message || "TTS failed",
      });
      activeRequestId = null;
    });
    provider.on("closed", (code, reason) => sendJson(ws, { type: "closed", code, reason }));
    return provider;
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
    const client = ensureProvider();
    if (!client) return;
    activeRequestId = payload.requestId;
    try {
      client.speak(payload.text);
    } catch (err) {
      sendJson(ws, {
        type: "error",
        requestId: payload.requestId,
        error: err instanceof Error ? err.message : "Voice TTS failed",
      });
      activeRequestId = null;
    }
  });

  ws.on("close", () => {
    provider?.close();
    provider = null;
    activeRequestId = null;
  });
  ws.on("error", (err) => {
    logger.warn({ err }, "Voice TTS websocket error");
    provider?.close();
    provider = null;
    activeRequestId = null;
  });
}
