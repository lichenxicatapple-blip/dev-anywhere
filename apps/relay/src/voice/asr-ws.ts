import { WebSocket, type RawData } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { BailianAsrClient, BailianAsrConfig } from "./bailian-asr.js";
import type { VoiceConfigStore } from "./config-store.js";
import type { VoiceAsrProviderClient, VoiceProviderRegistry } from "./provider.js";

export type VoiceAsrClientFactory = (config: BailianAsrConfig) => BailianAsrClient;

interface AsrStartMessage {
  type: "start";
  sessionId: string;
  sampleRate?: number;
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

function isStartMessage(payload: unknown): payload is AsrStartMessage {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return record.type === "start" && typeof record.sessionId === "string";
}

export function handleVoiceAsrConnection(
  ws: WebSocket,
  store: VoiceConfigStore,
  logger: Logger,
  providers: VoiceProviderRegistry,
): void {
  let provider: VoiceAsrProviderClient | null = null;

  function start(payload: AsrStartMessage): void {
    const config = store.readSecret();
    if (!config.apiKey) {
      sendJson(ws, {
        type: "error",
        errorCode: "not_configured",
        error: "Voice provider is not configured",
      });
      return;
    }
    provider?.close();
    provider = providers.current(config).createAsrClient(config, {
      sampleRate: payload.sampleRate ?? 16000,
      language: "zh",
    });
    provider.on("ready", () => sendJson(ws, { type: "ready" }));
    provider.on("partial", (text) => sendJson(ws, { type: "partial", text }));
    provider.on("final", (text) => sendJson(ws, { type: "final", text }));
    provider.on("error", (error) =>
      sendJson(ws, { type: "error", error: error.message || "ASR failed" }),
    );
    provider.on("closed", (code, reason) => sendJson(ws, { type: "closed", code, reason }));
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      provider?.sendPcm(toBuffer(data));
      return;
    }

    const payload = parseJson(data);
    if (isStartMessage(payload)) {
      start(payload);
      return;
    }
    if (payload && typeof payload === "object" && (payload as { type?: unknown }).type === "stop") {
      provider?.stop();
    }
  });

  ws.on("close", () => {
    provider?.close();
    provider = null;
  });
  ws.on("error", (err) => {
    logger.warn({ err }, "Voice ASR websocket error");
    provider?.close();
    provider = null;
  });
}
