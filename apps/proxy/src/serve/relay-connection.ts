import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import { serializeControl, type MessageEnvelope } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { createFSM } from "../common/state-machine.js";
import { MemoryMessageQueue } from "./message-queue.js";

// 默认 proxyId 存储路径
const DEFAULT_PROXY_ID_PATH = join(homedir(), ".dev-anywhere", "proxy-id");

// 指数退避上限 30 秒
const MAX_BACKOFF_MS = 30000;
// 退避基数 1 秒
const BASE_BACKOFF_MS = 1000;
// 消息队列上限
const MAX_QUEUE_SIZE = 10000;

export const RelayConnectionState = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  REGISTERING: "registering",
  SYNCED: "synced",
  WAITING_RECONNECT: "waiting_reconnect",
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
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.CONNECTING]: [
    RelayConnectionState.REGISTERING,
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.REGISTERING]: [
    RelayConnectionState.SYNCED,
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.SYNCED]: [
    RelayConnectionState.WAITING_RECONNECT,
    RelayConnectionState.CLOSED,
  ],
  [RelayConnectionState.WAITING_RECONNECT]: [
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
}

// 管理代理到中转服务器的出站 WebSocket 连接，支持自动重连和消息队列
export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private proxyId: string;
  private relayUrl: string;
  private queue: MemoryMessageQueue = new MemoryMessageQueue();
  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
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

  constructor(relayUrl: string, options?: RelayConnectionOptions) {
    super();
    this.relayUrl = relayUrl;
    this.proxyId = this.loadOrCreateProxyId(options?.proxyIdPath ?? DEFAULT_PROXY_ID_PATH);
    this.name = options?.name;
    this.token = options?.token;
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
    const dir = dirname(idPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(idPath, id, "utf-8");
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
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        // open 属异步回调，若同步 close() 已先切 CLOSED，REGISTERING 会被拒，需跳过后续 register
        if (!this.fsm.tryTransitionTo(RelayConnectionState.REGISTERING)) return;
        serviceLogger.info(
          { proxyId: this.proxyId, url: base, tokenSet: !!this.token },
          "Connected to relay server",
        );
        this.ws!.send(
          serializeControl({
            type: "proxy_register",
            proxyId: this.proxyId,
            ...(this.name ? { name: this.name } : {}),
          }),
        );
      });

      this.ws.on("message", (data) => {
        const raw = data.toString();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          serviceLogger.warn({ error: String(err) }, "Non-JSON message from relay, dropped");
          return;
        }
        if (msg.type === "proxy_register_response") {
          serviceLogger.info({ status: msg.status }, "Received register response");
          if (!this.fsm.tryTransitionTo(RelayConnectionState.SYNCED)) return;
          this.reconnectAttempt = 0;
          this.flushQueue();
          this.emit("connected");
          return;
        }
        this.emit("message", msg);
      });

      this.ws.on("close", () => {
        this.ws = null;
        if (this.fsm.current() !== RelayConnectionState.CLOSED) {
          this.fsm.tryTransitionTo(RelayConnectionState.WAITING_RECONNECT);
          serviceLogger.info("Relay connection closed unexpectedly");
          this.emit("disconnected");
          this.scheduleReconnect();
        } else {
          serviceLogger.info("Relay connection closed");
        }
      });

      this.ws.on("error", (err) => {
        serviceLogger.error({ error: String(err) }, "Relay connection error");
      });
    } catch (err) {
      serviceLogger.error({ error: String(err) }, "Failed to create relay connection");
      if (this.fsm.current() !== RelayConnectionState.CLOSED) {
        this.fsm.tryTransitionTo(RelayConnectionState.WAITING_RECONNECT);
        this.scheduleReconnect();
      }
    }
  }

  // 将队列中缓存的消息依次发送到 relay
  private flushQueue(): void {
    for (const raw of this.queue.drain()) {
      this.ws?.send(raw);
    }
  }

  // 计算全抖动指数退避延迟并调度重连
  private scheduleReconnect(): void {
    const backoff =
      Math.random() *
      Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempt));
    serviceLogger.info(
      { attempt: this.reconnectAttempt + 1, backoffMs: Math.round(backoff) },
      "Scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => {
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
      this.ws.send(data);
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
    this.fsm.tryTransitionTo(RelayConnectionState.CLOSED);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeControl({ type: "proxy_disconnect", proxyId: this.proxyId }));
      }
      this.ws.close();
      this.ws = null;
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
  } {
    return {
      connected: this.fsm.current() === RelayConnectionState.SYNCED,
      connectionState: this.fsm.current(),
      proxyId: this.proxyId,
      reconnectAttempt: this.reconnectAttempt,
      queueDepth: this.queue.size(),
    };
  }
}
