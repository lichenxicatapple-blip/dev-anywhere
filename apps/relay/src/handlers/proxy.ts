import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeProxyMessage } from "../router.js";

// 扩展 WebSocket 实例存储代理元数据
interface ProxySocket extends WebSocket {
  isAlive: boolean;
  proxyId?: string;
}

// 处理代理端 WebSocket 连接生命周期
export function handleProxyConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  const proxyWs = ws as ProxySocket;
  proxyWs.isAlive = true;

  proxyWs.on("pong", () => {
    proxyWs.isAlive = true;
  });

  proxyWs.on("message", (data) => {
    const raw = data.toString();
    const result = parseMessage(raw);

    if (result.kind === "control" && result.message.type === "proxy_register") {
      const { proxyId } = result.message;
      registry.registerProxy(proxyId, proxyWs);
      proxyWs.proxyId = proxyId;
      logger.info({ proxyId }, "Proxy registered");
      return;
    }

    if (result.kind === "envelope") {
      if (!proxyWs.proxyId) {
        proxyWs.send(JSON.stringify({
          type: "relay_error",
          code: "NOT_REGISTERED",
          message: "Proxy must register before sending messages",
        }));
        return;
      }
      routeProxyMessage(raw, proxyWs.proxyId, registry, logger);
      return;
    }

    if (result.kind === "invalid") {
      logger.warn({ error: result.error }, "Invalid message from proxy");
      return;
    }

    // 其他控制消息代理端不应发送
    logger.warn({ type: result.kind === "control" ? result.message.type : "unknown" }, "Unexpected control message from proxy");
  });

  proxyWs.on("close", () => {
    if (proxyWs.proxyId) {
      registry.unregisterProxy(proxyWs.proxyId);
      logger.info({ proxyId: proxyWs.proxyId }, "Proxy disconnected");
    }
  });

  proxyWs.on("error", (err) => {
    logger.error({ err, proxyId: proxyWs.proxyId }, "Proxy WebSocket error");
  });
}

// 设置代理端心跳检测，返回定时器以便关闭时清理
export function setupProxyHeartbeat(
  wss: WebSocketServer,
  interval = 30000,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const ws of wss.clients) {
      const proxyWs = ws as ProxySocket;
      if (!proxyWs.isAlive) {
        proxyWs.terminate();
        continue;
      }
      proxyWs.isAlive = false;
      proxyWs.ping();
    }
  }, interval);
}
