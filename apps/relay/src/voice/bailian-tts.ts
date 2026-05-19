import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import { bailianInferenceUrl, type BailianRegion } from "./bailian-endpoints.js";

type SocketOptions = { headers?: Record<string, string> };
type ProviderSocket = EventEmitter & {
  readyState: number;
  send: (data: string | Buffer) => void;
  close: (code?: number, reason?: string) => void;
};

export type BailianTtsSocketFactory = (url: string, options: SocketOptions) => ProviderSocket;

export interface BailianTtsConfig {
  apiKey: string;
  region: BailianRegion;
  model: string;
  voice: string;
  sampleRate: number;
}

export interface BailianTtsClient {
  on(event: "started" | "finished", handler: () => void): this;
  on(event: "audio", handler: (chunk: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: "closed", handler: (code?: number, reason?: string) => void): this;
  speak(text: string): void;
  close(): void;
}

interface BailianTtsClientOptions {
  socketFactory?: BailianTtsSocketFactory;
  taskIdFactory?: () => string;
}

const OPEN = 1;

function defaultSocketFactory(url: string, options: SocketOptions): ProviderSocket {
  return new WebSocket(url, options) as ProviderSocket;
}

function errorFromPayload(payload: unknown): Error {
  if (!payload || typeof payload !== "object") return new Error("Bailian TTS error");
  const record = payload as Record<string, unknown>;
  const header = record.header && typeof record.header === "object" ? record.header : null;
  let message = "Bailian TTS error";
  if (header && typeof (header as Record<string, unknown>).error_message === "string") {
    message = (header as Record<string, string>).error_message;
  } else if (typeof record.message === "string") {
    message = record.message;
  }
  return new Error(message);
}

function eventFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const header = record.header && typeof record.header === "object" ? record.header : null;
  const event = header ? (header as Record<string, unknown>).event : undefined;
  return typeof event === "string" ? event : "";
}

class BailianTtsClientImpl extends EventEmitter implements BailianTtsClient {
  private socket: ProviderSocket;
  private isOpen = false;
  private current: { taskId: string; text: string } | null = null;

  constructor(
    private readonly config: BailianTtsConfig,
    socketFactory: BailianTtsSocketFactory,
    private readonly taskIdFactory: () => string,
  ) {
    super();
    this.socket = socketFactory(bailianInferenceUrl(config.region), {
      headers: { Authorization: `bearer ${config.apiKey}` },
    });
    this.socket.on("open", () => this.handleOpen());
    this.socket.on("message", (data: unknown, isBinary?: boolean) =>
      this.handleMessage(data, isBinary),
    );
    this.socket.on("error", (err: unknown) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
    this.socket.on("close", (code?: number, reason?: Buffer) =>
      this.emit("closed", code, reason?.toString("utf8")),
    );
  }

  speak(text: string): void {
    if (this.current) {
      throw new Error("Bailian TTS is already speaking");
    }
    this.current = { taskId: this.taskIdFactory(), text };
    if (this.isOpen || this.socket.readyState === OPEN) {
      this.sendRunTask();
    }
  }

  close(): void {
    this.socket.close();
  }

  private handleOpen(): void {
    this.isOpen = true;
    if (this.current) this.sendRunTask();
  }

  private handleMessage(data: unknown, isBinary = false): void {
    const text = this.tryDecodeText(data, isBinary);
    if (!text) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.emit("audio", chunk);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(text);
      this.emit("audio", chunk);
      return;
    }

    const event = eventFromPayload(payload);
    if (event === "task-started") {
      this.emit("started");
      this.sendTextAndFinish();
      return;
    }
    if (event === "task-finished") {
      this.emit("finished");
      this.current = null;
      return;
    }
    if (event === "task-failed" || event === "task-error") {
      this.emit("error", errorFromPayload(payload));
      this.current = null;
    }
  }

  private tryDecodeText(data: unknown, isBinary: boolean): string | null {
    if (typeof data === "string") return data;
    if (isBinary) return null;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    return null;
  }

  private sendRunTask(): void {
    if (!this.current) return;
    this.socket.send(
      JSON.stringify({
        header: {
          action: "run-task",
          task_id: this.current.taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: this.config.model,
          input: {},
          parameters: {
            text_type: "PlainText",
            voice: this.config.voice,
            format: "pcm",
            sample_rate: this.config.sampleRate,
          },
        },
      }),
    );
  }

  private sendTextAndFinish(): void {
    if (!this.current) return;
    this.socket.send(
      JSON.stringify({
        header: { action: "continue-task", task_id: this.current.taskId },
        payload: { input: { text: this.current.text } },
      }),
    );
    this.socket.send(
      JSON.stringify({
        header: { action: "finish-task", task_id: this.current.taskId },
        payload: { input: {} },
      }),
    );
  }
}

export function createBailianTtsClient(
  config: BailianTtsConfig,
  options: BailianTtsClientOptions = {},
): BailianTtsClient {
  return new BailianTtsClientImpl(
    config,
    options.socketFactory ?? defaultSocketFactory,
    options.taskIdFactory ?? (() => nanoid()),
  );
}
