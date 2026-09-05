import WebSocket from "ws";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import {
  compareProxyRelayProtocolVersions,
  createFSM,
  isProxyProtocolRejectDirection,
  ProxyProtocolAdmissionDirection,
  RELAY_JSON_MESSAGE_MAX_BYTES,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayControlSchema,
  serializeControl,
  type MessageEnvelope,
  type ProxyProtocolAdmissionDirectionType,
  type ProxyProtocolRejectDirection,
} from "@dev-anywhere/shared";
import { atomicWriteFileSync } from "../common/atomic-write.js";
import { serviceLogger } from "../common/logger.js";
import { MemoryMessageQueue } from "./message-queue.js";
import { PROXY_VERSION } from "../version.js";

// 默认 proxyId 存储路径
const DEFAULT_PROXY_ID_PATH = join(homedir(), ".dev-anywhere", "proxy-id");

// 指数退避上限 30 秒
const MAX_BACKOFF_MS = 30000;
// 退避基数 1 秒
const BASE_BACKOFF_MS = 1000;
// 消息队列上限
const MAX_QUEUE_SIZE = 10000;
// proxy 侧主动心跳：网络切换时本机 TCP/WebSocket 可能保持半开，不能只等 close 事件。
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10000;
// Covers both the HTTP/WebSocket handshake and Relay registration. A transport which opens but
// never admits this Proxy is no more usable than one which never opens.
const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const RELAY_CONNECTION_WEBSOCKET_OPTIONS = {
  maxPayload: 10 * 1024 * 1024,
  perMessageDeflate: {
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    threshold: 32 * 1024,
    concurrencyLimit: 4,
    zlibDeflateOptions: {
      level: 3,
      memLevel: 7,
    },
  },
} as const;
export const RelayConnectionState = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  REGISTERING: "registering",
  SYNCED: "synced",
  WAITING_RECONNECT: "waiting_reconnect",
  BLOCKED_REMOTE: "blocked_remote",
  CLOSED: "closed",
} as const;
export type RelayConnectionState = (typeof RelayConnectionState)[keyof typeof RelayConnectionState];

// 合法的 WS 连接状态转移
// CLOSED 是终态；connect 流转: DISCONNECTED → CONNECTING → REGISTERING → SYNCED
// 断线: SYNCED/REGISTERING/CONNECTING → WAITING_RECONNECT → CONNECTING
// 主动关: 任意 → CLOSED
const RELAY_TRANSITIONS: Record<RelayConnectionState, readonly RelayConnectionState[]> = {
  [RelayConnectionState.DISCONNECTED]: [
    RelayConnectionState.CONNECTING,
    RelayConnectionState.BLOCKED_REMOTE,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.CONNECTING]: [
    RelayConnectionState.REGISTERING,
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.BLOCKED_REMOTE,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.REGISTERING]: [
    RelayConnectionState.SYNCED,
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.BLOCKED_REMOTE,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.SYNCED]: [
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.BLOCKED_REMOTE,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.WAITING_RECONNECT]: [
    RelayConnectionState.CONNECTING,
    RelayConnectionState.BLOCKED_REMOTE,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.BLOCKED_REMOTE]: [
    RelayConnectionState.CONNECTING,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.CLOSED]: [],
};

interface RelayConnectionOptions {
  // 自定义 proxyId 文件路径，测试时使用临时目录
  proxyIdPath?: string;
  // proxy 显示名称，注册时发送给 relay
  name?: string;
  // 公网 relay 的 /proxy 端点预共享 token, relay 侧 RELAY_PROXY_TOKEN 对应
  token?: string;
  // 发布包版本会随注册消息上报；Relay 用它做可观测性，响应自己的精确版本供自动升级。
  version?: string;
  // 测试/特殊部署覆盖；生产默认值见 DEFAULT_HEARTBEAT_*。
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
}

// 管理代理到中转服务器的出站 WebSocket 连接，支持自动重连和消息队列
export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private proxyId: string;
  private relayUrl: string;
  private queue: MemoryMessageQueue = new MemoryMessageQueue();
  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readyTimeout:
    | {
        socket: WebSocket;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private fsm = createFSM({
    initial: RelayConnectionState.DISCONNECTED as RelayConnectionState,
    transitions: RELAY_TRANSITIONS,
    onTransition: (from, to) =>
      serviceLogger.info({ from, to }, "RelayConnection state transition"),
    onRejected: (from, to, isAbsorbing) =>
      serviceLogger[isAbsorbing ? "debug" : "warn"](
        { from, to },
        isAbsorbing
          ? "Late event after absorbing state, ignored"
          : "Invalid relay connection transition rejected",
      ),
  });
  private name?: string;
  private token?: string;
  private version: string;
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private readyTimeoutMs: number;
  private protocolAdmissionDirection: ProxyProtocolAdmissionDirectionType =
    ProxyProtocolAdmissionDirection.COMPATIBLE;
  private disconnectedNotified = false;

  constructor(relayUrl: string, options?: RelayConnectionOptions) {
    super();
    this.relayUrl = relayUrl;
    this.proxyId = this.loadOrCreateProxyId(options?.proxyIdPath ?? DEFAULT_PROXY_ID_PATH);
    this.name = options?.name;
    this.token = options?.token;
    this.version = options?.version ?? PROXY_VERSION;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const configuredReadyTimeoutMs = options?.readyTimeoutMs;
    this.readyTimeoutMs =
      typeof configuredReadyTimeoutMs === "number" &&
      Number.isSafeInteger(configuredReadyTimeoutMs) &&
      configuredReadyTimeoutMs > 0
        ? configuredReadyTimeoutMs
        : DEFAULT_READY_TIMEOUT_MS;
  }

  // 从文件读取或生成新的 proxyId，生成后持久化到文件
  private loadOrCreateProxyId(idPath: string): string {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, "utf-8").trim();
      if (existing.length > 0) {
        return existing;
      }
    }

    const id = nanoid(21);
    atomicWriteFileSync(idPath, id, { ensureDir: true });
    return id;
  }

  // 连接到 relay server
  connect(): void {
    if (!this.fsm.tryTransitionTo(RelayConnectionState.CONNECTING)) return;
    this.doConnect();
  }

  // 实际建立 WebSocket 连接的内部方法
  private doConnect(): void {
    try {
      const base = this.relayUrl.replace(/\/$/, "") + "/proxy";
      const url = this.token ? `${base}?token=${encodeURIComponent(this.token)}` : base;
      this.ws = new WebSocket(url, RELAY_CONNECTION_WEBSOCKET_OPTIONS);
      const socket = this.ws;
      this.startReadyTimeout(socket);

      socket.on("open", () => {
        if (this.ws !== socket) return;
        // open 属异步回调，若同步 close() 已先切 CLOSED，REGISTERING 会被拒，需跳过后续 register
        if (!this.fsm.tryTransitionTo(RelayConnectionState.REGISTERING)) return;
        serviceLogger.info(
          { proxyId: this.proxyId, url: base, tokenSet: !!this.token },
          "Connected to relay server",
        );
        socket.send(
          serializeControl({
            type: "proxy_register",
            protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
            proxyId: this.proxyId,
            ...(this.name ? { name: this.name } : {}),
            proxyVersion: this.version,
          }),
        );
      });

      socket.on("message", (data, isBinary) => {
        // A superseded socket must not admit a newer attempt or clear its timers.
        if (this.ws !== socket) return;
        const buf = data as Buffer;
        if (isBinary) {
          if (this.fsm.current() !== RelayConnectionState.SYNCED) {
            this.rejectRelayProtocol(socket, "binary message before registration");
            return;
          }
          this.clearHeartbeatTimeout();
          this.emit("binary", buf);
          return;
        }
        if (buf.length > RELAY_JSON_MESSAGE_MAX_BYTES) {
          serviceLogger.warn(
            { size: buf.length },
            "JSON message from relay rejected: exceeds max size",
          );
          if (this.fsm.current() !== RelayConnectionState.SYNCED) {
            this.rejectRelayProtocol(socket, "oversized message before registration");
          }
          return;
        }
        const raw = buf.toString();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          serviceLogger.warn({ error: String(err) }, "Non-JSON message from relay, dropped");
          if (this.fsm.current() !== RelayConnectionState.SYNCED) {
            this.rejectRelayProtocol(socket, "invalid message before registration");
          }
          return;
        }
        this.clearHeartbeatTimeout();
        if (msg.type === "proxy_register_response") {
          // CLOSED is absorbing: a response already queued by ws after close() has no effect.
          if (this.fsm.current() === RelayConnectionState.CLOSED) return;
          if (this.fsm.current() !== RelayConnectionState.REGISTERING) {
            this.rejectRelayProtocol(socket, "unexpected registration response");
            return;
          }
          const response = RelayControlSchema.safeParse(msg);
          if (!response.success || response.data.type !== "proxy_register_response") {
            const direction = compareProxyRelayProtocolVersions(
              RELAY_CONTROL_PROTOCOL_VERSION,
              msg.protocolVersion,
            );
            serviceLogger.warn(
              { direction, issues: response.success ? undefined : response.error.issues },
              "Invalid Proxy registration response; terminating relay connection",
            );
            this.rejectRelayProtocol(
              socket,
              "invalid registration response",
              direction === ProxyProtocolAdmissionDirection.COMPATIBLE
                ? ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH
                : direction,
            );
            return;
          }
          const { status, relayVersion, connectionId } = response.data;
          serviceLogger.info({ status, relayVersion }, "Received register response");
          if (!this.fsm.tryTransitionTo(RelayConnectionState.SYNCED)) return;
          this.clearReadyTimeout(socket);
          this.reconnectAttempt = 0;
          this.protocolAdmissionDirection = ProxyProtocolAdmissionDirection.COMPATIBLE;
          this.startHeartbeat();
          this.flushQueue();
          this.emit("relay_version", relayVersion);
          this.emit("stream_connection", connectionId);
          this.disconnectedNotified = false;
          this.emit("connected");
          return;
        }
        if (this.fsm.current() !== RelayConnectionState.SYNCED) {
          this.rejectRelayProtocol(socket, "message before registration response");
          return;
        }
        this.emit("message", msg);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        if (this.ws !== socket) {
          serviceLogger.debug({ code }, "Close from inactive Relay socket ignored");
          return;
        }
        this.clearReadyTimeout(socket);
        this.stopHeartbeat();
        this.ws = null;
        const closeMeta = { code, reason: reason.toString() || undefined };
        if (code === RelayCloseCode.PROXY_PROTOCOL_REJECTED) {
          const direction = isProxyProtocolRejectDirection(closeMeta.reason)
            ? closeMeta.reason
            : ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH;
          this.applyProtocolRejection(direction, "websocket", closeMeta);
        } else if (this.fsm.current() !== RelayConnectionState.CLOSED) {
          this.fsm.tryTransitionTo(RelayConnectionState.WAITING_RECONNECT);
          serviceLogger.info(closeMeta, "Relay connection closed unexpectedly");
          this.emitDisconnectedOnce();
          this.scheduleReconnect();
        } else {
          serviceLogger.info(closeMeta, "Relay connection closed");
        }
      });

      socket.on("error", (err) => {
        if (this.ws !== socket) return;
        serviceLogger.error({ error: String(err) }, "Relay connection error");
      });

      socket.on("pong", () => {
        if (this.ws !== socket) return;
        this.clearHeartbeatTimeout();
      });
    } catch (err) {
      serviceLogger.error({ error: String(err) }, "Failed to create relay connection");
      if (this.fsm.current() !== RelayConnectionState.CLOSED) {
        this.fsm.tryTransitionTo(RelayConnectionState.WAITING_RECONNECT);
        this.scheduleReconnect();
      }
    }
  }

  private startReadyTimeout(socket: WebSocket): void {
    this.clearReadyTimeout();
    const timer = setTimeout(() => {
      if (this.readyTimeout?.socket !== socket) return;
      this.readyTimeout = undefined;
      if (
        this.ws !== socket ||
        (this.fsm.current() !== RelayConnectionState.CONNECTING &&
          this.fsm.current() !== RelayConnectionState.REGISTERING)
      ) {
        return;
      }

      serviceLogger.warn(
        { timeoutMs: this.readyTimeoutMs, state: this.fsm.current() },
        "Relay connection did not become ready in time",
      );
      // Retire the attempt before terminating its transport. This makes a response racing with
      // the timeout stale and ensures the later close event cannot schedule a second reconnect.
      this.stopHeartbeat();
      this.ws = null;
      if (!this.fsm.tryTransitionTo(RelayConnectionState.WAITING_RECONNECT)) return;
      this.emitDisconnectedOnce();
      this.scheduleReconnect();
      try {
        socket.terminate();
      } catch (error) {
        serviceLogger.debug({ error: String(error) }, "Timed-out Relay socket was already closed");
      }
    }, this.readyTimeoutMs);
    timer.unref?.();
    this.readyTimeout = { socket, timer };
  }

  private clearReadyTimeout(socket?: WebSocket): void {
    if (!this.readyTimeout || (socket && this.readyTimeout.socket !== socket)) return;
    clearTimeout(this.readyTimeout.timer);
    this.readyTimeout = undefined;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimeoutMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (!this.heartbeatTimeoutTimer) return;
    clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = null;
  }

  private sendHeartbeat(): void {
    const ws = this.ws;
    if (!ws || this.fsm.current() !== RelayConnectionState.SYNCED) return;

    if (ws.readyState !== WebSocket.OPEN) {
      this.terminateStaleSocket(ws, "heartbeat socket is not open");
      return;
    }

    if (this.heartbeatTimeoutTimer) {
      this.terminateStaleSocket(ws, "previous heartbeat did not receive pong");
      return;
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (this.ws === ws && this.fsm.current() !== RelayConnectionState.CLOSED) {
        this.terminateStaleSocket(ws, "relay heartbeat pong timeout");
      }
    }, this.heartbeatTimeoutMs);
    this.heartbeatTimeoutTimer.unref?.();

    try {
      ws.ping((err?: Error) => {
        if (err && this.ws === ws && this.fsm.current() !== RelayConnectionState.CLOSED) {
          this.terminateStaleSocket(ws, `relay heartbeat ping failed: ${String(err)}`);
        }
      });
    } catch (err) {
      this.terminateStaleSocket(ws, `relay heartbeat ping threw: ${String(err)}`);
    }
  }

  private terminateStaleSocket(ws: WebSocket, reason: string): void {
    this.clearHeartbeatTimeout();
    if (this.ws !== ws || this.fsm.current() === RelayConnectionState.CLOSED) return;
    serviceLogger.warn({ reason }, "Relay connection heartbeat failed; terminating stale socket");
    ws.terminate();
  }

  private rejectRelayProtocol(
    ws: WebSocket,
    detail: string,
    direction: ProxyProtocolRejectDirection = ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
  ): void {
    if (this.ws !== ws || this.fsm.current() === RelayConnectionState.CLOSED) return;
    this.clearReadyTimeout(ws);
    this.stopHeartbeat();
    serviceLogger.warn({ detail, direction }, "Relay control protocol rejected");
    // Retire ownership before initiating the close handshake. A real ws peer normally echoes our
    // 4405 close code asynchronously; leaving this socket current would make the close handler
    // emit a second `disconnected` notification for the same rejection.
    this.ws = null;
    ws.close(RelayCloseCode.PROXY_PROTOCOL_REJECTED, direction);
    this.applyProtocolRejection(direction, "local_validation");
  }

  /** Apply a result from the stable HTTP bootstrap channel. */
  applyProtocolAdmission(direction: ProxyProtocolAdmissionDirectionType): void {
    if (direction === ProxyProtocolAdmissionDirection.COMPATIBLE) {
      if (!this.fsm.is(RelayConnectionState.BLOCKED_REMOTE)) return;
      this.protocolAdmissionDirection = direction;
      if (!this.fsm.tryTransitionTo(RelayConnectionState.CONNECTING)) return;
      serviceLogger.info("Relay control protocol is compatible; reconnecting");
      this.doConnect();
      return;
    }
    this.applyProtocolRejection(direction, "http_bootstrap");
  }

  private applyProtocolRejection(
    direction: ProxyProtocolRejectDirection,
    source: "websocket" | "http_bootstrap" | "local_validation",
    closeMeta?: { code: number; reason?: string },
  ): void {
    const previousState = this.fsm.current();
    if (previousState === RelayConnectionState.CLOSED) return;
    if (
      direction === ProxyProtocolAdmissionDirection.RELAY_OUTDATED &&
      previousState === RelayConnectionState.BLOCKED_REMOTE
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearReadyTimeout();
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    this.protocolAdmissionDirection = direction;

    const targetState =
      direction === ProxyProtocolAdmissionDirection.RELAY_OUTDATED
        ? RelayConnectionState.BLOCKED_REMOTE
        : RelayConnectionState.CLOSED;
    if (!this.fsm.tryTransitionTo(targetState)) return;

    serviceLogger.warn(
      { direction, source, previousState, ...closeMeta },
      direction === ProxyProtocolAdmissionDirection.RELAY_OUTDATED
        ? "Relay control protocol is older; WebSocket retries paused"
        : direction === ProxyProtocolAdmissionDirection.PROXY_OUTDATED
          ? "Proxy control protocol is older; waiting for Proxy update"
          : "Proxy/Relay control protocol mismatch; retries stopped",
    );
    this.emit("protocol_blocked", { direction, source });

    // When HTTP wins the race, own and retire the in-flight WebSocket first. Its eventual close is
    // stale and therefore cannot emit another disconnect or start another reconnect chain.
    if (socket) {
      try {
        socket.terminate();
      } catch (error) {
        serviceLogger.debug(
          { error: String(error), direction },
          "Protocol-blocked Relay socket was already closed",
        );
      }
    }
    if (previousState !== RelayConnectionState.DISCONNECTED) this.emitDisconnectedOnce();
  }

  private emitDisconnectedOnce(): void {
    if (this.disconnectedNotified) return;
    this.disconnectedNotified = true;
    this.emit("disconnected");
  }

  // 将队列中缓存的消息依次发送到 relay
  private flushQueue(): void {
    for (const raw of this.queue.drain()) {
      this.ws?.send(raw);
    }
  }

  // 计算全抖动指数退避延迟并调度重连
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.fsm.current() !== RelayConnectionState.WAITING_RECONNECT) {
      return;
    }
    const backoff =
      Math.random() *
      Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempt));
    serviceLogger.info(
      { attempt: this.reconnectAttempt + 1, backoffMs: Math.round(backoff) },
      "Scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      // 必须先回 CONNECTING 才能让 open handler 合法转到 REGISTERING；
      // 若 close() 抢先切 CLOSED（clearTimeout 理论上拦得住，保险再守一层），跳过重连
      if (!this.fsm.tryTransitionTo(RelayConnectionState.CONNECTING)) return;
      this.doConnect();
    }, backoff);
  }

  // 发送 MessageEnvelope 到 relay，离线时自动入队
  sendEnvelope(envelope: MessageEnvelope): void {
    const raw = JSON.stringify(envelope);
    this.sendRaw(raw);
  }

  // 发送 binary PTY 帧到 relay，断线时直接丢弃不入队
  // 接受 Uint8Array 而非强制 Buffer：encodeBinaryFrame 在 shared 包返回 Uint8Array，
  // ws.send 在底层同样支持 Uint8Array，无需额外 Buffer.from 拷贝。
  sendBinary(data: Uint8Array): void {
    if (
      this.fsm.current() === RelayConnectionState.SYNCED &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws.send(data, { binary: true, compress: false });
    }
    // binary 帧无队列，断线丢弃
  }

  // 发送原始 JSON 字符串到 relay，根据 connectionState 决定直发、入队或丢弃
  sendRaw(raw: string): void {
    if (
      this.fsm.current() === RelayConnectionState.SYNCED &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws.send(raw);
    } else if (this.fsm.current() === RelayConnectionState.CLOSED) {
      serviceLogger.warn("Message discarded: connection is closed");
    } else {
      if (this.queue.size() >= MAX_QUEUE_SIZE) {
        const dropped = this.queue.dropOldest();
        serviceLogger.warn(
          { maxSize: MAX_QUEUE_SIZE },
          "Message queue overflow, oldest message dropped",
        );
        // 通知订阅方（WorkerRegistry）补偿被丢的 envelope，例如清理 pending 审批
        if (dropped !== null) this.emit("envelope_dropped", dropped);
      }
      this.queue.enqueue(raw);
      serviceLogger.debug({ queueSize: this.queue.size() }, "Message queued during disconnect");
    }
  }

  // 主动关闭连接，发送 proxy_disconnect 通知 relay 立即清理，不触发重连
  close(): void {
    // 幂等：已 CLOSED 直接跳过，避免 FSM 抛 closed -> closed
    if (this.fsm.is(RelayConnectionState.CLOSED)) return;
    const wasSynced = this.fsm.is(RelayConnectionState.SYNCED);
    this.fsm.tryTransitionTo(RelayConnectionState.CLOSED);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearReadyTimeout();
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        // proxy_disconnect is application traffic and must never be emitted before admission.
        if (wasSynced) {
          socket.send(serializeControl({ type: "proxy_disconnect", proxyId: this.proxyId }));
        }
        socket.close();
      } else {
        socket.terminate();
      }
    }
  }

  // 获取当前 proxyId
  getProxyId(): string {
    return this.proxyId;
  }

  // 获取连接状态摘要，用于 CLI status 输出
  getStatus(): {
    connected: boolean;
    connectionState: RelayConnectionState;
    proxyId: string;
    reconnectAttempt: number;
    queueDepth: number;
    protocolAdmissionDirection: ProxyProtocolAdmissionDirectionType;
  } {
    return {
      connected: this.fsm.current() === RelayConnectionState.SYNCED,
      connectionState: this.fsm.current(),
      proxyId: this.proxyId,
      reconnectAttempt: this.reconnectAttempt,
      queueDepth: this.queue.size(),
      protocolAdmissionDirection: this.protocolAdmissionDirection,
    };
  }
}
