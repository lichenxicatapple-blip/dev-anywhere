import {
  VoiceAsrServerMessageSchema,
  type VoiceAsrAudioEncoding,
  type VoiceAsrServerMessage,
} from "@dev-anywhere/shared";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 5_000;
const DEFAULT_IN_FLIGHT_WINDOW_BYTES = 32 * 1024;

export type VoiceAsrAttemptCompletionReason = "closed" | "timeout";

export interface VoiceAsrAttemptOptions {
  sessionId: string;
  attemptId: string;
  sampleRate: number;
  encoding: VoiceAsrAudioEncoding;
}

export interface VoiceAsrAttemptSnapshot {
  attemptId: string;
  queuedBytes: number;
  sentBytes: number;
  acknowledgedBytes: number;
  acknowledgedPcmBytes: number;
  acknowledgedChunks: number;
  finishRequested: boolean;
  stopSent: boolean;
}

export interface VoiceAsrAttempt {
  readonly attemptId: string;
  send(chunk: Uint8Array): void;
  finish(): void;
  abort(): void;
  snapshot(): VoiceAsrAttemptSnapshot;
}

interface VoiceAsrTransportOptions {
  url: string;
  createSocket?: (url: string) => WebSocket;
  readyTimeoutMs?: number;
  completionTimeoutMs?: number;
  inFlightWindowBytes?: number;
  onPartial: (text: string, attemptId: string) => void;
  onFinal: (text: string, attemptId: string) => void;
  onAttemptComplete?: (attemptId: string, reason: VoiceAsrAttemptCompletionReason) => void;
  onAttemptError: (error: string, attemptId: string) => void;
  onTransportError: (error: string) => void;
  onTrace?: (event: string, details: Record<string, unknown>) => void;
}

interface ActiveAttempt {
  options: VoiceAsrAttemptOptions;
  queue: Uint8Array[];
  queuedBytes: number;
  sentBytes: number;
  acknowledgedBytes: number;
  acknowledgedPcmBytes: number;
  acknowledgedChunks: number;
  ready: boolean;
  finishRequested: boolean;
  stopSent: boolean;
  terminal: boolean;
  readyTimeoutId: number;
  completionTimeoutId: number | null;
  resolveReady: (attempt: VoiceAsrAttempt) => void;
  rejectReady: (error: Error) => void;
  publicAttempt: VoiceAsrAttempt;
}

function parseServerMessage(data: unknown): VoiceAsrServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = VoiceAsrServerMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class VoiceAsrTransport {
  private readonly options: Required<
    Pick<
      VoiceAsrTransportOptions,
      "readyTimeoutMs" | "completionTimeoutMs" | "inFlightWindowBytes"
    >
  > &
    Omit<
      VoiceAsrTransportOptions,
      "readyTimeoutMs" | "completionTimeoutMs" | "inFlightWindowBytes"
    >;
  private socket: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private activeAttempt: ActiveAttempt | null = null;
  private disposed = false;

  constructor(options: VoiceAsrTransportOptions) {
    this.options = {
      ...options,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      completionTimeoutMs: options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS,
      inFlightWindowBytes: options.inFlightWindowBytes ?? DEFAULT_IN_FLIGHT_WINDOW_BYTES,
    };
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("语音识别连接已关闭"));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;

    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectConnection = () => {
        if (settled) return;
        settled = true;
        reject(new Error("语音识别连接不可用"));
      };
      socket.addEventListener("open", () => {
        if (this.socket !== socket || this.disposed) {
          rejectConnection();
          return;
        }
        settled = true;
        this.trace("socket-open", {});
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(socket, event.data));
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        rejectConnection();
        const hadActiveAttempt = this.activeAttempt !== null;
        this.failActiveAttempt("语音识别连接已断开");
        if (!this.disposed && !hadActiveAttempt) {
          this.options.onTransportError("语音识别连接已断开");
        }
        this.trace("socket-closed", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      });
      socket.addEventListener("error", () => {
        if (this.socket !== socket) return;
        rejectConnection();
        this.trace("socket-error", {});
      });
    }).finally(() => {
      if (this.connectionPromise === promise) this.connectionPromise = null;
    });
    this.connectionPromise = promise;
    return promise;
  }

  async startAttempt(options: VoiceAsrAttemptOptions): Promise<VoiceAsrAttempt> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("语音识别连接不可用");
    }
    this.activeAttempt?.publicAttempt.abort();

    let resolveReady!: (attempt: VoiceAsrAttempt) => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<VoiceAsrAttempt>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state = {} as ActiveAttempt;
    const publicAttempt: VoiceAsrAttempt = {
      attemptId: options.attemptId,
      send: (chunk) => this.enqueue(state, chunk),
      finish: () => this.finish(state),
      abort: () => this.abort(state),
      snapshot: () => this.snapshot(state),
    };
    Object.assign(state, {
      options,
      queue: [],
      queuedBytes: 0,
      sentBytes: 0,
      acknowledgedBytes: 0,
      acknowledgedPcmBytes: 0,
      acknowledgedChunks: 0,
      ready: false,
      finishRequested: false,
      stopSent: false,
      terminal: false,
      completionTimeoutId: null,
      resolveReady,
      rejectReady,
      publicAttempt,
      readyTimeoutId: window.setTimeout(() => {
        if (this.activeAttempt !== state || state.ready || state.terminal) return;
        this.failAttempt(state, "语音识别服务准备超时");
      }, this.options.readyTimeoutMs),
    } satisfies ActiveAttempt);
    this.activeAttempt = state;
    socket.send(JSON.stringify({ type: "start", ...options }));
    this.trace("attempt-start-sent", { attemptId: options.attemptId, encoding: options.encoding });
    return readyPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeAttempt?.publicAttempt.abort();
    this.activeAttempt = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket) return;
    const message = parseServerMessage(data);
    if (!message) {
      this.trace("invalid-message", {});
      return;
    }
    const state = this.activeAttempt;
    if (!state || state.options.attemptId !== message.attemptId) {
      this.trace("stale-message", {
        attemptId: message.attemptId,
        activeAttemptId: state?.options.attemptId ?? null,
        messageType: message.type,
      });
      return;
    }
    switch (message.type) {
      case "ready":
        if (state.ready || state.terminal) return;
        state.ready = true;
        window.clearTimeout(state.readyTimeoutId);
        state.resolveReady(state.publicAttempt);
        this.trace("attempt-ready", { attemptId: message.attemptId });
        this.pump(state);
        return;
      case "audio_ack":
        state.acknowledgedBytes = Math.max(
          state.acknowledgedBytes,
          Math.min(message.encodedBytes, state.sentBytes),
        );
        state.acknowledgedPcmBytes = Math.max(state.acknowledgedPcmBytes, message.pcmBytes);
        state.acknowledgedChunks = Math.max(state.acknowledgedChunks, message.chunks);
        this.pump(state);
        return;
      case "partial":
        this.options.onPartial(message.text, message.attemptId);
        this.refreshCompletionTimeout(state);
        return;
      case "final":
        this.options.onFinal(message.text, message.attemptId);
        this.refreshCompletionTimeout(state);
        return;
      case "closed":
        if (!state.ready) {
          this.failAttempt(state, "语音识别连接已断开");
          return;
        }
        if (!state.finishRequested) {
          this.failAttempt(state, "语音识别连接已断开");
          return;
        }
        this.completeAttempt(state, "closed");
        return;
      case "error":
        this.failAttempt(state, message.error ?? "语音识别失败");
        return;
    }
  }

  private enqueue(state: ActiveAttempt, chunk: Uint8Array): void {
    if (this.activeAttempt !== state || state.terminal || state.finishRequested) return;
    const copy = chunk.slice();
    state.queue.push(copy);
    state.queuedBytes += copy.byteLength;
    this.pump(state);
  }

  private finish(state: ActiveAttempt): void {
    if (this.activeAttempt !== state || state.terminal || state.finishRequested) return;
    state.finishRequested = true;
    this.pump(state);
  }

  private abort(state: ActiveAttempt): void {
    if (state.terminal) return;
    state.terminal = true;
    state.queue = [];
    state.queuedBytes = 0;
    window.clearTimeout(state.readyTimeoutId);
    if (state.completionTimeoutId !== null) {
      window.clearTimeout(state.completionTimeoutId);
      state.completionTimeoutId = null;
    }
    if (!state.ready) state.rejectReady(new Error("语音识别已取消"));
    if (this.activeAttempt === state) {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "stop", attemptId: state.options.attemptId }));
      }
      this.activeAttempt = null;
    }
  }

  private pump(state: ActiveAttempt): void {
    if (this.activeAttempt !== state || !state.ready || state.terminal) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (!next) break;
      const inFlightBytes = state.sentBytes - state.acknowledgedBytes;
      if (inFlightBytes > 0 && inFlightBytes + next.byteLength > this.options.inFlightWindowBytes) {
        break;
      }
      state.queue.shift();
      state.queuedBytes -= next.byteLength;
      state.sentBytes += next.byteLength;
      socket.send(next);
    }
    if (state.finishRequested && state.queue.length === 0 && !state.stopSent) {
      state.stopSent = true;
      socket.send(JSON.stringify({ type: "stop", attemptId: state.options.attemptId }));
      this.trace("attempt-stop-sent", { ...this.snapshot(state) });
      this.refreshCompletionTimeout(state);
    }
  }

  private refreshCompletionTimeout(state: ActiveAttempt): void {
    if (
      this.activeAttempt !== state ||
      state.terminal ||
      !state.finishRequested ||
      !state.stopSent
    ) {
      return;
    }
    if (state.completionTimeoutId !== null) {
      window.clearTimeout(state.completionTimeoutId);
    }
    state.completionTimeoutId = window.setTimeout(() => {
      if (this.activeAttempt !== state || state.terminal) return;
      this.trace("attempt-completion-timeout", { ...this.snapshot(state) });
      this.completeAttempt(state, "timeout");
    }, this.options.completionTimeoutMs);
  }

  private completeAttempt(
    state: ActiveAttempt,
    reason: VoiceAsrAttemptCompletionReason,
  ): void {
    if (state.terminal) return;
    state.terminal = true;
    window.clearTimeout(state.readyTimeoutId);
    if (state.completionTimeoutId !== null) {
      window.clearTimeout(state.completionTimeoutId);
      state.completionTimeoutId = null;
    }
    if (this.activeAttempt === state) this.activeAttempt = null;
    this.options.onAttemptComplete?.(state.options.attemptId, reason);
  }

  private failActiveAttempt(error: string): void {
    const state = this.activeAttempt;
    if (state) this.failAttempt(state, error);
  }

  private failAttempt(state: ActiveAttempt, error: string): void {
    if (state.terminal) return;
    state.terminal = true;
    window.clearTimeout(state.readyTimeoutId);
    if (state.completionTimeoutId !== null) {
      window.clearTimeout(state.completionTimeoutId);
      state.completionTimeoutId = null;
    }
    if (state.ready) {
      this.options.onAttemptError(error, state.options.attemptId);
    } else {
      state.rejectReady(new Error(error));
    }
    if (this.activeAttempt === state) this.activeAttempt = null;
  }

  private snapshot(state: ActiveAttempt): VoiceAsrAttemptSnapshot {
    return {
      attemptId: state.options.attemptId,
      queuedBytes: state.queuedBytes,
      sentBytes: state.sentBytes,
      acknowledgedBytes: state.acknowledgedBytes,
      acknowledgedPcmBytes: state.acknowledgedPcmBytes,
      acknowledgedChunks: state.acknowledgedChunks,
      finishRequested: state.finishRequested,
      stopSent: state.stopSent,
    };
  }

  private trace(event: string, details: Record<string, unknown>): void {
    this.options.onTrace?.(event, details);
  }
}
