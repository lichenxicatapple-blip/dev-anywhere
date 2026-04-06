import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Logger } from "pino";
import { RelayRegistry } from "./registry.js";
import { healthRouter } from "./health.js";
import {
  handleProxyConnection,
  setupProxyHeartbeat,
} from "./handlers/proxy.js";
import {
  handleClientConnection,
  setupClientHeartbeat,
} from "./handlers/client.js";

export interface RelayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  logger: Logger;
}

export interface RelayServer {
  httpServer: Server;
  registry: RelayRegistry;
  close: () => Promise<void>;
}

// 创建中转服务器，Express HTTP + ws WebSocket 双端点
export function createRelayServer(options: RelayServerOptions): RelayServer {
  const { heartbeatInterval = 30000, logger } = options;

  const registry = new RelayRegistry();
  const app = express();
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

  const proxyHeartbeat = setupProxyHeartbeat(proxyWss, heartbeatInterval);
  const clientHeartbeat = setupClientHeartbeat(clientWss, heartbeatInterval);

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
