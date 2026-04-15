import { WebSocket } from "ws";
import type { Logger } from "@cc-anywhere/shared";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeProxyMessage } from "../router.js";

// binary 帧最大允许大小（10MB），超过的帧静默丢弃以防 DoS
const MAX_BINARY_FRAME_SIZE = 10 * 1024 * 1024;

// proxy → client 透传的控制消息类型，relay 不处理内容，直接转发
export const PROXY_TO_CLIENT_TYPES = new Set([
  "terminal_title",
  "terminal_resize",
  "pty_state",
  "dir_list_response",
  "dir_create_response",
  "session_create_response",
  "session_history_messages",
  "pending_approvals_push",
  "command_list_push",
  "file_tree_push",
  "session_history_response",
  "session_list",
]);

// 扩展 WebSocket 实例存储代理元数据
interface ProxySocket extends WebSocket {
  isAlive: boolean;
  proxyId?: string;
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已离线
function notifyClientsProxyOffline(proxyId: string, registry: RelayRegistry, logger: Logger): void {
  const clients = registry.getClientsForProxy(proxyId);
  for (const clientWs of clients) {
    clientWs.send(JSON.stringify({ type: "proxy_offline", proxyId }));
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy offline");
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已上线
function notifyClientsProxyOnline(proxyId: string, registry: RelayRegistry, logger: Logger): void {
  const clients = registry.getClientsForProxy(proxyId);
  for (const clientWs of clients) {
    clientWs.send(JSON.stringify({ type: "proxy_online", proxyId }));
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy online");
}

// proxy 上线或下线时，将最新的 proxy 列表推送给所有已连接的 client。
// 复用 proxy_list_response 消息类型，client 端已有对应处理逻辑，无需额外适配。
function broadcastProxyList(registry: RelayRegistry): void {
  const proxies = registry.listProxiesWithName().map(p => ({
    ...p,
    sessions: registry.getSessionsForProxy(p.proxyId),
  }));
  const msg = JSON.stringify({ type: "proxy_list_response", proxies });
  for (const clientWs of registry.getAllClientWs()) {
    clientWs.send(msg);
  }
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

  proxyWs.on("message", (data: Buffer, isBinary: boolean) => {
    // D-07: binary 帧透传，只解析 sessionId 前缀用于路由，不修改内容
    if (isBinary) {
      if (data.length < 2 || data.length > MAX_BINARY_FRAME_SIZE) {
        logger.warn({ size: data.length }, "Binary frame rejected: invalid size");
        return;
      }
      const sessionIdLen = data[0];
      if (sessionIdLen === 0 || sessionIdLen > 255 || data.length < 1 + sessionIdLen) {
        logger.warn({ sessionIdLen, dataLen: data.length }, "Binary frame rejected: malformed sessionId prefix");
        return;
      }
      if (!proxyWs.proxyId) {
        logger.warn("Binary frame from unregistered proxy, dropped");
        return;
      }

      // D-42: zero-copy, forward entire buffer including sessionId prefix
      const clients = registry.getClientsForProxy(proxyWs.proxyId);
      for (const clientWs of clients) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      }
      return;
    }

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
        notifyClientsProxyOnline(proxyId, registry, logger);
      }

      broadcastProxyList(registry);
      return;
    }

    if (result.kind === "control" && result.message.type === "proxy_disconnect") {
      if (proxyWs.proxyId) {
        notifyClientsProxyOffline(proxyWs.proxyId, registry, logger);
        registry.markProxyOffline(proxyWs.proxyId);
        logger.info({ proxyId: proxyWs.proxyId }, "Proxy gracefully disconnected, marked offline");
        proxyWs.proxyId = undefined;
        broadcastProxyList(registry);
      }
      return;
    }

    // proxy 重连后同步 session 列表，relay 据此建立 proxy-session 关联
    if (result.kind === "control" && result.message.type === "session_sync") {
      if (!proxyWs.proxyId) return;
      const sessions = result.message.sessions as Array<{ id: string }>;
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          registry.addSessionToProxy(proxyWs.proxyId, s.id);
        }
        logger.info({ proxyId: proxyWs.proxyId, count: sessions.length }, "Session sync received");
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
        logger.info({ proxyId: proxyWs.proxyId, type: result.message.type, clientCount: clients.length }, "Forwarded control message from proxy to clients");
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
        message: `${result.error} | raw: ${raw.slice(0, 200)}`,
      }));
      return;
    }
  });

  proxyWs.on("close", () => {
    if (proxyWs.proxyId) {
      notifyClientsProxyOffline(proxyWs.proxyId, registry, logger);
      // 通过状态转换标记离线，保留所有状态等待重连
      // proxy_disconnect 已经清理过的情况下 transition 会抛异常，静默忽略
      try {
        registry.transitionProxy(proxyWs.proxyId, "online", "offline");
      } catch {
        // proxy 已被 proxy_disconnect 清理或已离线，跳过
      }
      logger.info({ proxyId: proxyWs.proxyId }, "Proxy disconnected, state preserved for reconnect");
      broadcastProxyList(registry);
    }
  });

  proxyWs.on("error", (err) => {
    logger.error({ err, proxyId: proxyWs.proxyId }, "Proxy WebSocket error");
  });
}

