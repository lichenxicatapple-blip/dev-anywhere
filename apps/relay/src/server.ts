import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Logger } from "@cc-anywhere/shared";
import { RelayRegistry } from "./registry.js";
import { BufferStore } from "./buffer-store.js";
import { healthRouter } from "./health.js";
import { handleProxyConnection } from "./handlers/proxy.js";
import { handleClientConnection } from "./handlers/client.js";
import { setupHeartbeat } from "./heartbeat.js";

export interface RelayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  logger: Logger;
  dataDir?: string;
}

export interface RelayServer {
  httpServer: Server;
  registry: RelayRegistry;
  close: () => Promise<void>;
}

// 创建中转服务器，Express HTTP + ws WebSocket 双端点
export function createRelayServer(options: RelayServerOptions): RelayServer {
  const { heartbeatInterval = 30000, logger, dataDir } = options;

  const store = dataDir ? new BufferStore(dataDir) : null;
  if (!store) {
    logger.warn("DATA_DIR not set, buffer persistence disabled. Relay restart will lose all buffered messages.");
  }
  const registry = new RelayRegistry(store);
  const app = express();

  // 静态文件服务：字体等资源，从 DATA_DIR/fonts 或默认 ~/.cc-anywhere/relay-data/fonts 提供
  const fontsDir = dataDir ? `${dataDir}/fonts` : `${process.env.HOME}/.cc-anywhere/relay-data/fonts`;
  app.use("/fonts", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  }, express.static(fontsDir, {
    maxAge: "30d",
    immutable: true,
  }));

  app.use(healthRouter(registry));

  // 使用 createServer 而非 app.listen，确保 WebSocket upgrade 可在同一端口上处理
  const httpServer = createServer(app);

  const proxyWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");

    if (pathname === "/proxy") {
      proxyWss.handleUpgrade(request, socket, head, (ws) => {
        proxyWss.emit("connection", ws, request);
      });
      return;
    }

    if (pathname === "/client") {
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
      return;
    }

    socket.destroy();
  });

  proxyWss.on("connection", (ws) => {
    handleProxyConnection(ws, registry, logger);
  });

  clientWss.on("connection", (ws) => {
    handleClientConnection(ws, registry, logger);
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
