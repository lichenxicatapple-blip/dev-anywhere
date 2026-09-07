import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnScript } from "../../common/env.js";
import { tryConnectSocket } from "../../common/socket-connect.js";
import { ReconnectSupervisor } from "../../common/reconnect-supervisor.js";
import { serviceLogger } from "../../common/logger.js";
import { PREVIEW_WORKER_SOCK, PROFILE_NAME } from "../../common/paths.js";
import { readWorkerConnection } from "../../ipc/worker-connection.js";
import {
  PREVIEW_WORKER_PROTOCOL_VERSION,
  readPreviewWorkerMessages,
  writePreviewWorkerMessage,
  type PreviewControlRequest,
  type PreviewWorkerRelay,
} from "../../ipc/preview-worker-protocol.js";

class PreviewWorkerProtocolError extends Error {}

interface PreviewWorkerClientOptions {
  relay: Omit<PreviewWorkerRelay, "connectionId">;
  send: (raw: string) => void;
  socketPath?: string;
  profile?: string;
  spawn?: () => void;
  startupTimeoutMs?: number;
}

/** A replaceable attachment. close() never sends a stop command to the runtime. */
export class PreviewWorkerClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private candidate: Socket | null = null;
  private closed = false;
  private blocked = false;
  private lastError?: string;
  private relay: PreviewWorkerRelay;
  private readonly reconnect = new ReconnectSupervisor({ initialDelayMs: 500, maxDelayMs: 5_000 });

  constructor(private readonly options: PreviewWorkerClientOptions) {
    this.relay = { ...options.relay, connectionId: null };
  }

  start(): void {
    void this.connect().catch((error: unknown) => this.connectionFailed(error));
  }

  register(connectionId: string): void {
    this.relay = { ...this.relay, connectionId };
    this.configure();
  }

  disconnectRelay(): void {
    this.relay = { ...this.relay, connectionId: null };
    this.configure();
  }

  async handle(message: PreviewControlRequest): Promise<void> {
    const relay = this.relay;
    try {
      const socket = await this.connect();
      if (!this.closed && relay === this.relay && socket === this.socket && socket.writable)
        writePreviewWorkerMessage(socket, { type: "preview_worker_request", message });
    } catch (error) {
      this.connectionFailed(error);
    }
  }

  close(): void {
    this.closed = true;
    this.candidate?.destroy();
    this.socket?.destroy();
    this.socket = null;
  }

  private configure(): void {
    if (this.socket?.writable)
      writePreviewWorkerMessage(this.socket, {
        type: "preview_worker_configure",
        relay: this.relay,
      });
  }

  private connect(): Promise<Socket> {
    if (this.closed || this.blocked)
      return Promise.reject(new Error("Preview worker attachment is closed"));
    if (this.socket?.writable && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const task = this.connectOnce();
    this.connecting = task;
    void task
      .finally(() => {
        if (this.connecting === task) this.connecting = null;
      })
      .catch(() => {});
    return task;
  }

  private async connectOnce(): Promise<Socket> {
    const endpoint = this.options.socketPath ?? PREVIEW_WORKER_SOCK;
    const profile = this.options.profile ?? PROFILE_NAME;
    let socket = await tryConnectSocket(endpoint);
    if (this.closed) {
      socket?.destroy();
      throw new Error("Preview attachment closed");
    }
    if (!socket) {
      if (this.options.spawn) this.options.spawn();
      else
        spawnScript("preview-worker", ["--profile", profile], {
          env: { ...process.env, DEV_ANYWHERE_PROCESS_ROLE: "preview-worker" },
          stdio: "ignore",
          logger: serviceLogger,
        });
      const deadline = performance.now() + (this.options.startupTimeoutMs ?? 20_000);
      while (!this.closed && performance.now() < deadline && !socket) {
        await sleep(100);
        if (this.closed) break;
        socket = await tryConnectSocket(endpoint);
      }
    }
    if (!socket || this.closed) {
      socket?.destroy();
      throw new Error("Preview worker did not become available");
    }
    const connected = socket;
    this.candidate = connected;
    return new Promise<Socket>((resolve, reject) => {
      let accepted = false;
      readWorkerConnection(connected, {
        read: readPreviewWorkerMessages,
        isHello: (message) =>
          message.type === "preview_worker_hello" || message.type === "serve_preview_hello",
        acceptHello: (message) =>
          message.type === "preview_worker_hello" &&
          message.profile === profile &&
          message.protocolVersion === PREVIEW_WORKER_PROTOCOL_VERSION,
        onAccepted: () => {
          if (this.closed) {
            connected.destroy();
            return;
          }
          accepted = true;
          this.socket = connected;
          this.candidate = null;
          this.lastError = undefined;
          this.configure();
          resolve(connected);
        },
        onMessage: (message) => {
          if (this.closed || this.socket !== connected) return;
          if (message.type === "preview_worker_event")
            this.options.send(JSON.stringify(message.message));
          else connected.destroy();
        },
        onError: (error) => {
          if (!accepted) reject(new PreviewWorkerProtocolError(error.message));
          connected.destroy();
        },
      });
      connected.on("error", (error) => {
        if (!accepted) reject(error);
      });
      connected.once("close", () => {
        if (this.candidate === connected) this.candidate = null;
        if (!accepted) reject(new Error("Preview worker disconnected before handshake"));
        if (this.socket !== connected) return;
        this.socket = null;
        if (!this.closed) this.scheduleReconnect();
      });
      writePreviewWorkerMessage(connected, {
        type: "serve_preview_hello",
        protocolVersion: PREVIEW_WORKER_PROTOCOL_VERSION,
        profile,
      });
    });
  }

  private connectionFailed(error: unknown): void {
    if (this.closed) return;
    if (error instanceof PreviewWorkerProtocolError) this.blocked = true;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.lastError) {
      this.lastError = message;
      serviceLogger.warn({ error: message }, "Preview worker is unavailable");
    }
    if (!this.blocked) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.blocked) return;
    void this.reconnect
      .request({
        shouldStop: () => this.closed || this.blocked,
        attempt: async () => {
          try {
            await this.connect();
            return "connected";
          } catch (error) {
            this.connectionFailed(error);
            return this.blocked ? "stop" : "retry";
          }
        },
      })
      .completion.catch((error: unknown) => this.connectionFailed(error));
  }
}
