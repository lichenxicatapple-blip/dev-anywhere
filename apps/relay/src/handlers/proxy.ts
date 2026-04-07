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
      const status = registry.registerProxy(proxyId, proxyWs);
      proxyWs.proxyId = proxyId;
      logger.info({ proxyId, status }, "Proxy registered");

      // 回传注册结果和 per-session 数据水位，proxy 据此决定是否需要 EventStore 回放
      const sessions = status === "reconnected" ? registry.getSessionSeqMap(proxyId) : undefined;
      proxyWs.send(JSON.stringify({
        type: "proxy_register_response",
        status,
        sessions,
      }));

      if (status === "reconnected") {
        const clients = registry.getClientsForProxy(proxyId);
        for (const clientWs of clients) {
          clientWs.send(JSON.stringify({ type: "proxy_online", proxyId }));
        }
      }
      return;
    }

    if (result.kind === "control" && result.message.type === "proxy_disconnect") {
      if (proxyWs.proxyId) {
        const clients = registry.getClientsForProxy(proxyWs.proxyId);
        for (const clientWs of clients) {
          clientWs.send(JSON.stringify({ type: "proxy_offline", proxyId: proxyWs.proxyId }));
        }
        registry.unregisterProxy(proxyWs.proxyId);
        logger.info({ proxyId: proxyWs.proxyId }, "Proxy gracefully disconnected, resources cleaned up");
        proxyWs.proxyId = undefined;
      }
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
      // 通知所有绑定的客户端 proxy 已离线
      const clients = registry.getClientsForProxy(proxyWs.proxyId);
      for (const clientWs of clients) {
        clientWs.send(JSON.stringify({
          type: "proxy_offline",
          proxyId: proxyWs.proxyId,
        }));
      }
      // 标记离线，保留所有状态等待重连
      registry.markProxyOffline(proxyWs.proxyId);
      logger.info({ proxyId: proxyWs.proxyId }, "Proxy disconnected, state preserved for reconnect");
    }
  });

  proxyWs.on("error", (err) => {
    logger.error({ err, proxyId: proxyWs.proxyId }, "Proxy WebSocket error");
  });
}

