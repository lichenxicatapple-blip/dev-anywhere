import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import type { MessageEnvelope } from "@cc-anywhere/shared";
import { logger } from "./logger.js";
import { MemoryMessageQueue } from "./message-queue.js";

// 默认 proxyId 存储路径
const DEFAULT_PROXY_ID_PATH = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".cc-anywhere",
  "proxy-id",
);

// 指数退避上限 30 秒
const MAX_BACKOFF_MS = 30000;
// 退避基数 1 秒
const BASE_BACKOFF_MS = 1000;

export interface RelayConnectionOptions {
  // 自定义 proxyId 文件路径，测试时使用临时目录
  proxyIdPath?: string;
  // proxy 显示名称，注册时发送给 relay
  name?: string;
}

// 管理代理到中转服务器的出站 WebSocket 连接，支持自动重连和消息队列
export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private proxyId: string;
  private relayUrl: string;
  private queue: MemoryMessageQueue = new MemoryMessageQueue();
  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed: boolean = false;
  private name?: string;

  constructor(relayUrl: string, options?: RelayConnectionOptions) {
    super();
    this.relayUrl = relayUrl;
    this.proxyId = this.loadOrCreateProxyId(options?.proxyIdPath ?? DEFAULT_PROXY_ID_PATH);
    this.name = options?.name;
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
    this.closed = false;
    this.doConnect();
  }

  // 实际建立 WebSocket 连接的内部方法
  private doConnect(): void {
    try {
      const url = this.relayUrl.replace(/\/$/, "") + "/proxy";
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.reconnectAttempt = 0;
        logger.info({ proxyId: this.proxyId, url }, "Connected to relay server");
        this.ws!.send(JSON.stringify({
          type: "proxy_register",
          proxyId: this.proxyId,
          ...(this.name ? { name: this.name } : {}),
        }));
      });

      this.ws.on("message", (data) => {
        const raw = data.toString();
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === "proxy_register_response") {
            const status: string = parsed.status;
            const sessions: Record<string, number> | undefined = parsed.sessions;
            logger.info({ status, sessionCount: sessions ? Object.keys(sessions).length : 0 }, "Received register response");
            // 先 emit sync 让调用方补数据，再 flush 队列保证顺序
            this.emit("sync", { status, sessions: sessions ?? {} });
            this.flushQueue();
            this.emit("connected");
            return;
          }
        } catch {
          // 非 JSON 消息，正常转发
        }
        this.emit("message", raw);
      });

      this.ws.on("close", () => {
        this.ws = null;
        if (!this.closed) {
          logger.info("Relay connection closed unexpectedly");
          this.emit("disconnected");
          this.scheduleReconnect();
        } else {
          logger.info("Relay connection closed");
        }
      });

      this.ws.on("error", (err) => {
        logger.error({ error: String(err) }, "Relay connection error");
      });
    } catch (err) {
      logger.error({ error: String(err) }, "Failed to create relay connection");
      if (!this.closed) {
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
    const backoff = Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempt));
    logger.info(
      { attempt: this.reconnectAttempt + 1, backoffMs: Math.round(backoff) },
      "Scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.doConnect();
    }, backoff);
  }

  // 发送 MessageEnvelope 到 relay，离线时自动入队
  send(envelope: MessageEnvelope): void {
    const raw = JSON.stringify(envelope);
    this.sendRaw(raw);
  }

  // 发送原始 JSON 字符串到 relay，离线时自动入队
  // 用于 handler 模块直接发送已序列化的 relay control 消息
  sendRaw(raw: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.queue.enqueue(raw);
      logger.debug({ queueSize: this.queue.size() }, "Message queued during disconnect");
    }
  }

  // 主动关闭连接，发送 proxy_disconnect 通知 relay 立即清理，不触发重连
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "proxy_disconnect", proxyId: this.proxyId }));
      }
      this.ws.close();
      this.ws = null;
    }
  }

  // 获取当前 proxyId
  getProxyId(): string {
    return this.proxyId;
  }
}
