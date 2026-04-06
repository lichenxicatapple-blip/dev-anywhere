import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage } from "../router.js";

// 扩展 WebSocket 实例存储客户端元数据
interface ClientSocket extends WebSocket {
  isAlive: boolean;
}

// 处理远程客户端 WebSocket 连接生命周期
export function handleClientConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  const clientWs = ws as ClientSocket;
  clientWs.isAlive = true;

  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  clientWs.on("message", (data) => {
    const raw = data.toString();
    const result = parseMessage(raw);

    if (result.kind === "control") {
      const msg = result.message;

      if (msg.type === "proxy_list_request") {
        const proxies = registry.listProxies().map((id) => ({ proxyId: id }));
        clientWs.send(JSON.stringify({
          type: "proxy_list_response",
          proxies,
        }));
        return;
      }

      if (msg.type === "proxy_select") {
        const bound = registry.bindClient(clientWs, msg.proxyId);
        if (!bound) {
          clientWs.send(JSON.stringify({
            type: "relay_error",
            code: "PROXY_NOT_FOUND",
            message: `Proxy not online: ${msg.proxyId}`,
          }));
          return;
        }
        logger.info({ proxyId: msg.proxyId }, "Client bound to proxy");
        return;
      }

      clientWs.send(JSON.stringify({
        type: "relay_error",
        code: "UNSUPPORTED",
        message: `Unsupported control message: ${msg.type}`,
      }));
      return;
    }

    if (result.kind === "envelope") {
      routeClientMessage(raw, clientWs, registry, logger);
      return;
    }

    logger.warn({ error: result.error }, "Invalid message from client");
  });

  clientWs.on("close", () => {
    registry.unbindClient(clientWs);
    logger.info("Client disconnected");
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}

// 设置客户端心跳检测，返回定时器以便关闭时清理
export function setupClientHeartbeat(
  wss: WebSocketServer,
  interval = 30000,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const ws of wss.clients) {
      const clientWs = ws as ClientSocket;
      if (!clientWs.isAlive) {
        clientWs.terminate();
        continue;
      }
      clientWs.isAlive = false;
      clientWs.ping();
    }
  }, interval);
}
