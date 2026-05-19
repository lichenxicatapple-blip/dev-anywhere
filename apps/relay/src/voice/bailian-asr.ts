import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import { bailianRealtimeUrl, type BailianRegion } from "./bailian-endpoints.js";

type SocketOptions = { headers?: Record<string, string> };
type ProviderSocket = EventEmitter & {
  readyState: number;
  send: (data: string | Buffer) => void;
  close: (code?: number, reason?: string) => void;
};

export type BailianAsrEvent = "ready" | "partial" | "final" | "error" | "closed";
export type BailianAsrSocketFactory = (url: string, options: SocketOptions) => ProviderSocket;

export interface BailianAsrConfig {
  apiKey: string;
  region: BailianRegion;
  model: string;
  sampleRate: number;
  language: string;
}

export interface BailianAsrClient {
  on(event: "ready", handler: () => void): this;
  on(event: "partial" | "final", handler: (text: string) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: "closed", handler: (code?: number, reason?: string) => void): this;
  sendPcm(chunk: Buffer): void;
  stop(): void;
  close(): void;
}

interface BailianAsrClientOptions {
  socketFactory?: BailianAsrSocketFactory;
  eventIdFactory?: () => string;
}

const OPEN = 1;
const END_OF_SPEECH_SILENCE_MS = 1200;

function defaultSocketFactory(url: string, options: SocketOptions): ProviderSocket {
  return new WebSocket(url, options) as ProviderSocket;
}

function extractRealtimePreview(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.text === "string" || typeof record.stash === "string") {
    const text = typeof record.text === "string" ? record.text : "";
    const stash = typeof record.stash === "string" ? record.stash : "";
    const preview = `${text}${stash}`;
    return preview.length > 0 ? preview : null;
  }
  const candidates = [
    record.text,
    record.transcript,
    record.delta,
    record.output &&
      typeof record.output === "object" &&
      (record.output as Record<string, unknown>).text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function extractFinalText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.transcript,
    record.text,
    record.output &&
      typeof record.output === "object" &&
      (record.output as Record<string, unknown>).text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function extractError(payload: unknown): Error {
  if (!payload || typeof payload !== "object") return new Error("Bailian ASR error");
  const record = payload as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? record.error : null;
  let message = "Bailian ASR error";
  if (nested && typeof (nested as Record<string, unknown>).message === "string") {
    message = (nested as Record<string, string>).message;
  } else if (typeof record.message === "string") {
    message = record.message;
  }
  return new Error(message);
}

class BailianAsrClientImpl extends EventEmitter implements BailianAsrClient {
  private socket: ProviderSocket;
  private isOpen = false;
  private isReady = false;
  private pending: string[] = [];

  constructor(
    private readonly config: BailianAsrConfig,
    socketFactory: BailianAsrSocketFactory,
    private readonly eventIdFactory: () => string,
  ) {
    super();
    this.socket = socketFactory(bailianRealtimeUrl(config.region, config.model), {
      headers: {
        Authorization: `bearer ${config.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    this.socket.on("open", () => this.handleOpen());
    this.socket.on("message", (data: unknown) => this.handleMessage(data));
    this.socket.on("error", (err: unknown) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
    this.socket.on("close", (code?: number, reason?: Buffer) =>
      this.emit("closed", code, reason?.toString("utf8")),
    );
  }

  sendPcm(chunk: Buffer): void {
    this.sendWhenReady({
      event_id: this.eventIdFactory(),
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64"),
    });
  }

  stop(): void {
    this.sendWhenReady({
      event_id: this.eventIdFactory(),
      type: "session.finish",
    });
  }

  close(): void {
    this.socket.close();
  }

  private handleOpen(): void {
    this.isOpen = true;
    this.sendNow({
      event_id: this.eventIdFactory(),
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: this.config.sampleRate,
        input_audio_transcription: {
          language: this.config.language,
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0,
          silence_duration_ms: END_OF_SPEECH_SILENCE_MS,
        },
      },
    });
  }

  private handleMessage(data: unknown): void {
    const text =
      typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    if (!text) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const record = payload as { type?: unknown };
    const type = typeof record.type === "string" ? record.type : "";
    if (type.includes("error")) {
      this.emit("error", extractError(payload));
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      this.emit("error", extractError(payload));
      return;
    }
    if (type === "session.updated") {
      this.isReady = true;
      this.emit("ready");
      this.flushPending();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.text") {
      const preview = extractRealtimePreview(payload);
      if (preview) this.emit("partial", preview);
      return;
    }
    if (
      type === "conversation.item.input_audio_transcription.completed" ||
      type === "session.finished"
    ) {
      const transcript = extractFinalText(payload);
      if (transcript) {
        this.emit("final", transcript);
      }
    }
  }

  private sendWhenReady(payload: unknown): void {
    const message = JSON.stringify(payload);
    if ((this.isOpen || this.socket.readyState === OPEN) && this.isReady) {
      this.socket.send(message);
      return;
    }
    this.pending.push(message);
  }

  private sendNow(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  private flushPending(): void {
    for (const message of this.pending) {
      this.socket.send(message);
    }
    this.pending = [];
  }
}

export function createBailianAsrClient(
  config: BailianAsrConfig,
  options: BailianAsrClientOptions = {},
): BailianAsrClient {
  return new BailianAsrClientImpl(
    config,
    options.socketFactory ?? defaultSocketFactory,
    options.eventIdFactory ?? (() => `event_${nanoid()}`),
  );
}
