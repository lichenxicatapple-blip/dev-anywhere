import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { MessageEnvelope } from "@cc-anywhere/shared";

// 默认 proxyId 存储路径
const DEFAULT_PROXY_ID_PATH = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".cc-anywhere",
  "proxy-id",
);

export interface RelayConnectionOptions {
  // 自定义 proxyId 文件路径，测试时使用临时目录
  proxyIdPath?: string;
}

// 管理代理到中转服务器的出站 WebSocket 连接
export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private proxyId: string;
  private logger: Logger;
  private relayUrl: string;

  constructor(relayUrl: string, logger: Logger, options?: RelayConnectionOptions) {
    super();
    this.relayUrl = relayUrl;
    this.logger = logger;
    this.proxyId = this.loadOrCreateProxyId(options?.proxyIdPath ?? DEFAULT_PROXY_ID_PATH);
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

  // 连接到 relay server 的 /proxy 端点
  connect(): void {
    try {
      const url = this.relayUrl.replace(/\/$/, "") + "/proxy";
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.logger.info({ proxyId: this.proxyId, url }, "Connected to relay server");
        this.ws!.send(JSON.stringify({ type: "proxy_register", proxyId: this.proxyId }));
      });

      this.ws.on("message", (data) => {
        const raw = data.toString();
        this.emit("message", raw);
      });

      this.ws.on("close", () => {
        this.logger.info("Relay connection closed");
      });

      this.ws.on("error", (err) => {
        this.logger.error({ error: String(err) }, "Relay connection error");
      });
    } catch (err) {
      this.logger.error({ error: String(err) }, "Failed to create relay connection");
    }
  }

  // 发送 MessageEnvelope 到 relay
  send(envelope: MessageEnvelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    } else {
      this.logger.warn("Relay connection not open, message dropped");
    }
  }

  // 关闭 WebSocket 连接
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // 获取当前 proxyId
  getProxyId(): string {
    return this.proxyId;
  }
}
