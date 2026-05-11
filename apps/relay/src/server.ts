import express from "express";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import { RelayRegistry } from "./registry.js";
import { healthRouter } from "./health.js";
import { handleProxyConnection } from "./handlers/proxy.js";
import { handleClientConnection } from "./handlers/client.js";
import { setupHeartbeat } from "./heartbeat.js";
import { createRelayChaos, type RelayChaosOptions } from "./chaos.js";

export interface RelayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  logger: Logger;
  dataDir?: string;
  // proxy 注册预共享 token; 不传 / 空串则关闭鉴权 (开发默认)
  proxyToken?: string;
  // client 连接预共享 token; 不传 / 空串则关闭鉴权 (开发默认)
  clientToken?: string;
  // ws upgrade 时校验的 Origin 列表 (匹配 request.headers.origin)。空数组 / undefined 不
  // 校验, 向后兼容现有部署 (本地 dev 跨端口 / Capacitor 等)。设置后只放白名单, 阻挡
  // CSWSH——攻击者站点诱导用户浏览器直接发 ws upgrade 到 relay 时, 没有合法 Origin。
  allowedOrigins?: readonly string[];
  chaos?: RelayChaosOptions;
  fontAssetDir?: string;
}

export interface RelayServer {
  httpServer: Server;
  registry: RelayRegistry;
  close: () => Promise<void>;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGED_FONTS_DIR = resolve(MODULE_DIR, "../assets/fonts");

// 创建中转服务器，Express HTTP + ws WebSocket 双端点
export function createRelayServer(options: RelayServerOptions): RelayServer {
  const { heartbeatInterval = 30000, logger, dataDir, proxyToken, clientToken, chaos } = options;
  const proxyTokenRequired = typeof proxyToken === "string" && proxyToken.length > 0;
  const clientTokenRequired = typeof clientToken === "string" && clientToken.length > 0;
  const allowedOriginsSet =
    options.allowedOrigins && options.allowedOrigins.length > 0
      ? new Set(options.allowedOrigins)
      : null;
  const checkOrigin = (origin: string | undefined): boolean => {
    if (!allowedOriginsSet) return true;
    return typeof origin === "string" && allowedOriginsSet.has(origin);
  };
  if (!proxyTokenRequired) {
    logger.warn(
      "proxy auth token not set, /proxy endpoint is open — ok for dev, not for public relay",
    );
  }
  if (!clientTokenRequired) {
    logger.warn(
      "client auth token not set, /client endpoint is open — ok for dev, not for public relay",
    );
  }

  const registry = new RelayRegistry();
  const relayChaos = chaos?.enabled ? createRelayChaos(chaos, logger) : undefined;
  if (chaos?.enabled) {
    logger.warn(
      {
        delayMs: chaos.delayMs,
        duplicate: chaos.duplicate,
        reorder: chaos.reorder,
        types: chaos.types ? [...chaos.types] : "all",
      },
      "Relay chaos mode enabled",
    );
  }
  const app = express();

  // 字体优先读持久化目录；Docker 镜像再回退到随包内置字体，避免空 volume 让 Web 字体 404。
  const fontsDir = dataDir ? `${dataDir}/fonts` : `${homedir()}/.dev-anywhere/relay-data/fonts`;
  const fontAssetDir = options.fontAssetDir ?? PACKAGED_FONTS_DIR;
  app.use(
    "/fonts",
    (req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      next();
    },
    express.static(fontsDir, {
      maxAge: "30d",
      immutable: true,
    }),
  );
  if (existsSync(fontAssetDir)) {
    app.use(
      "/fonts",
      express.static(fontAssetDir, {
        maxAge: "30d",
        immutable: true,
      }),
    );
  }

  app.use(
    healthRouter(registry, {
      proxyTokenRequired,
      clientTokenRequired,
      validateClientToken: (token) => token === clientToken,
      validateProxyToken: (token) => token === proxyToken,
      getClientToken: () => clientToken ?? null,
    }),
  );

  // 使用 createServer 而非 app.listen，确保 WebSocket upgrade 可在同一端口上处理
  const httpServer = createServer(app);

  const proxyWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    const origin = request.headers.origin;

    if (!checkOrigin(origin)) {
      logger.warn(
        { ip: request.socket.remoteAddress, origin: origin ?? "(missing)", pathname },
        "rejected upgrade: origin not in allowedOrigins",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname === "/proxy") {
      if (proxyTokenRequired) {
        const token = url.searchParams.get("token");
        if (token !== proxyToken) {
          logger.warn(
            { ip: request.socket.remoteAddress },
            "rejected /proxy upgrade: invalid token",
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      proxyWss.handleUpgrade(request, socket, head, (ws) => {
        proxyWss.emit("connection", ws, request);
      });
      return;
    }

    if (pathname === "/client") {
      if (clientTokenRequired) {
        const token = url.searchParams.get("token");
        if (token !== clientToken) {
          logger.warn(
            { ip: request.socket.remoteAddress },
            "rejected /client upgrade: invalid token",
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
      return;
    }

    socket.destroy();
  });

  proxyWss.on("connection", (ws) => {
    handleProxyConnection(ws, registry, logger, relayChaos);
  });

  clientWss.on("connection", (ws) => {
    handleClientConnection(ws, registry, logger, relayChaos);
  });

  const proxyHeartbeat = setupHeartbeat(proxyWss, heartbeatInterval);
  const clientHeartbeat = setupHeartbeat(clientWss, heartbeatInterval);

  async function close(): Promise<void> {
    clearInterval(proxyHeartbeat);
    clearInterval(clientHeartbeat);

    for (const ws of proxyWss.clients) {
      ws.terminate();
    }
    for (const ws of clientWss.clients) {
      ws.terminate();
    }

    await new Promise<void>((resolve, reject) => {
      proxyWss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      clientWss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { httpServer, registry, close };
}
