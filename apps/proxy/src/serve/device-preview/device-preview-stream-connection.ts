import WebSocket from "ws";
import {
  DevicePreviewStreamServerMessageSchema,
  encodeDevicePreviewFrame,
  encodeDevicePreviewH264ProxyPacket,
} from "@dev-anywhere/shared";
import type { DevicePreviewH264Packet } from "./types.js";
import { serviceLogger } from "../../common/logger.js";

const STREAM_JSON_MAX_BYTES = 64 * 1024;
const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const STREAM_WEBSOCKET_OPTIONS = {
  maxPayload: STREAM_JSON_MAX_BYTES,
  perMessageDeflate: false,
} as const;

interface PendingFrame {
  frame: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface DevicePreviewStreamConnectionOptions {
  relayUrl: string;
  proxyId: string;
  token?: string;
  onFlow: (streamId: string, paused: boolean, resyncRequired: boolean) => void;
  createWebSocket?: (url: string, options: typeof STREAM_WEBSOCKET_OPTIONS) => WebSocket;
  random?: () => number;
}

function streamError(message: string): Error {
  const error = new Error(message);
  error.name = "DevicePreviewStreamConnectionError";
  return error;
}

export class DevicePreviewStreamConnection {
  private readonly relayUrl: string;
  private readonly proxyId: string;
  private readonly token?: string;
  private readonly onFlow: (streamId: string, paused: boolean, resyncRequired: boolean) => void;
  private readonly createWebSocket: NonNullable<
    DevicePreviewStreamConnectionOptions["createWebSocket"]
  >;
  private readonly random: () => number;
  private readonly pendingFrames = new Map<string, PendingFrame>();
  private ws: WebSocket | null = null;
  private connectionId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private ready = false;
  private closed = false;
  private registrationRejected = false;

  constructor(options: DevicePreviewStreamConnectionOptions) {
    this.relayUrl = options.relayUrl;
    this.proxyId = options.proxyId;
    this.token = options.token;
    this.onFlow = options.onFlow;
    this.createWebSocket =
      options.createWebSocket ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
    this.random = options.random ?? Math.random;
  }

  register(connectionId: string): void {
    if (this.closed) return;
    this.connectionId = connectionId;
    this.registrationRejected = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.replaceSocket();
  }

  disconnectMain(): void {
    this.connectionId = null;
    this.registrationRejected = false;
    this.ready = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.terminate();
    this.rejectPending(streamError("设备画面连接已断开"));
  }

  sendFrame(streamId: string, frameSequence: number, jpeg: Buffer): Promise<void> {
    if (this.closed || !this.connectionId) {
      return Promise.reject(streamError("设备画面连接不可用"));
    }
    if (this.pendingFrames.has(streamId)) {
      return Promise.reject(streamError("同一设备画面流已有待发送帧"));
    }

    let frame: Buffer;
    try {
      frame = Buffer.from(encodeDevicePreviewFrame(streamId, frameSequence, jpeg));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : streamError("设备画面编码失败"));
    }
    const pending = new Promise<void>((resolve, reject) => {
      this.pendingFrames.set(streamId, { frame, resolve, reject });
    });
    this.flushPending();
    return pending;
  }

  sendH264Packet(
    streamId: string,
    packetSequence: number,
    packet: Pick<DevicePreviewH264Packet, "kind" | "keyframe" | "durationMs" | "data">,
  ): Promise<void> {
    if (this.closed || !this.connectionId) {
      return Promise.reject(streamError("设备画面连接不可用"));
    }
    if (this.pendingFrames.has(streamId)) {
      return Promise.reject(streamError("同一设备画面流已有待发送数据"));
    }

    let frame: Buffer;
    try {
      frame = Buffer.from(
        encodeDevicePreviewH264ProxyPacket(streamId, {
          packetSequence,
          configuration: packet.kind === "configuration",
          keyframe: packet.keyframe,
          durationMs: packet.durationMs,
          annexB: packet.data,
        }),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : streamError("设备画面编码失败"));
    }
    const pending = new Promise<void>((resolve, reject) => {
      this.pendingFrames.set(streamId, { frame, resolve, reject });
    });
    this.flushPending();
    return pending;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionId = null;
    this.ready = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
    this.rejectPending(streamError("设备画面连接已关闭"));
  }

  private replaceSocket(): void {
    const old = this.ws;
    this.ws = null;
    this.ready = false;
    if (old) old.terminate();
    this.connect();
  }

  private connect(): void {
    const connectionId = this.connectionId;
    if (this.closed || !connectionId || this.registrationRejected || this.ws) return;
    const base = `${this.relayUrl.replace(/\/$/u, "")}/proxy-stream`;
    const url = this.token ? `${base}?token=${encodeURIComponent(this.token)}` : base;
    let ws: WebSocket;
    try {
      ws = this.createWebSocket(url, STREAM_WEBSOCKET_OPTIONS);
    } catch (error) {
      serviceLogger.warn({ error: String(error) }, "Could not create device preview stream socket");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.once("open", () => {
      if (this.ws !== ws || this.connectionId !== connectionId) return;
      ws.send(
        JSON.stringify({
          type: "device_preview_stream_register",
          proxyId: this.proxyId,
          connectionId,
        }),
      );
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) {
        serviceLogger.warn("Binary message rejected on Proxy device preview stream socket");
        ws.terminate();
        return;
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buffer.length > STREAM_JSON_MAX_BYTES) {
        ws.terminate();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString("utf8")) as unknown;
      } catch {
        ws.terminate();
        return;
      }
      const message = DevicePreviewStreamServerMessageSchema.safeParse(parsed);
      if (!message.success) {
        ws.terminate();
        return;
      }
      if (message.data.type === "device_preview_stream_register_response") {
        if (!message.data.success) {
          this.registrationRejected = true;
          this.rejectPending(streamError(message.data.error));
          ws.close();
          return;
        }
        this.ready = true;
        this.reconnectAttempt = 0;
        this.flushPending();
        return;
      }
      this.onFlow(message.data.streamId, message.data.paused, message.data.resyncRequired);
    });
    ws.once("error", (error) => {
      serviceLogger.warn({ error: String(error) }, "Device preview stream socket error");
    });
    ws.once("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.scheduleReconnect();
    });
  }

  private flushPending(): void {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
    for (const [streamId, pending] of [...this.pendingFrames]) {
      this.pendingFrames.delete(streamId);
      ws.send(pending.frame, { binary: true, compress: false }, (error?: Error) => {
        if (error) pending.reject(error);
        else pending.resolve();
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.connectionId || this.registrationRejected || this.reconnectTimer) {
      return;
    }
    const ceiling = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const delay = Math.floor(this.random() * ceiling);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pendingFrames.values()];
    this.pendingFrames.clear();
    for (const frame of pending) frame.reject(error);
  }
}
