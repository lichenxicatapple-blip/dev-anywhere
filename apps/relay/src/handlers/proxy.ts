import { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeProxyMessage } from "../router.js";

// proxy → client 透传的控制消息类型，relay 不处理内容，直接转发
export const PROXY_TO_CLIENT_TYPES = new Set([
  "terminal_frame",
  "terminal_title",
  "terminal_resize",
  "pty_state",
  "terminal_lines_response",
  "dir_list_response",
  "command_list_push",
  "file_tree_push",
  "session_history_response",
]);

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
      const { proxyId, name } = result.message;
      const status = registry.registerProxy(proxyId, proxyWs, name);
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

    // proxy 发给 client 的控制消息：直接转发给绑定的客户端，不进 session buffer
    if (result.kind === "control") {
      if (PROXY_TO_CLIENT_TYPES.has(result.message.type)) {
        if (!proxyWs.proxyId) {
          proxyWs.send(JSON.stringify({
            type: "relay_error",
            code: "NOT_REGISTERED",
            message: "Proxy must register before sending messages",
          }));
          return;
        }
        const clients = registry.getClientsForProxy(proxyWs.proxyId);
        for (const clientWs of clients) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(raw);
          }
        }
        logger.debug({ proxyId: proxyWs.proxyId, type: result.message.type }, "Forwarded control message from proxy to clients");
        return;
      }
      // 其他控制消息代理端不应发送
      logger.warn({ type: result.message.type }, "Unexpected control message from proxy");
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
      logger.error({ error: result.error, raw: raw.slice(0, 200) }, "Invalid message from proxy");
      proxyWs.send(JSON.stringify({
        type: "relay_error",
        code: "INVALID_MESSAGE",
        message: result.error,
      }));
      return;
    }
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

