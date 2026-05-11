import { WebSocket } from "ws";
import {
  isProxyToClientRelayControlType,
  RelayErrorCode,
  serializeControl,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeProxyMessage } from "../router.js";
import type { RelayChaos } from "../chaos.js";

// binary 帧最大允许大小（10MB），超过的帧静默丢弃以防 DoS
const MAX_BINARY_FRAME_SIZE = 10 * 1024 * 1024;

// 扩展 WebSocket 实例存储代理元数据
interface ProxySocket extends WebSocket {
  isAlive: boolean;
  proxyId?: string;
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已离线
function notifyClientsProxyOffline(
  proxyId: string,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const clients = registry.getClientsForProxy(proxyId);
  const msg = JSON.stringify({ type: "proxy_offline", proxyId });
  for (const clientWs of clients) {
    if (chaos) chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_offline" });
    else clientWs.send(msg);
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy offline");
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已上线
function notifyClientsProxyOnline(
  proxyId: string,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const clients = registry.getClientsForProxy(proxyId);
  const msg = JSON.stringify({ type: "proxy_online", proxyId });
  for (const clientWs of clients) {
    if (chaos) chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_online" });
    else clientWs.send(msg);
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy online");
}

// proxy 上线或下线时，将最新的 proxy 列表推送给所有已连接的 client。
// 复用 proxy_list_response 消息类型，client 端已有对应处理逻辑，无需额外适配。
function broadcastProxyList(registry: RelayRegistry, chaos?: RelayChaos): void {
  const proxies = registry.listProxiesWithName().map((p) => ({
    ...p,
    sessions: registry.getSessionsForProxy(p.proxyId),
  }));
  const msg = JSON.stringify({ type: "proxy_list_response", proxies });
  for (const clientWs of registry.getAllClientWs()) {
    if (chaos)
      chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_list_response" });
    else clientWs.send(msg);
  }
}

function rejectNotRegistered(ws: ProxySocket): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      code: RelayErrorCode.NOT_REGISTERED,
      message: "Proxy must register before sending messages",
    }),
  );
}

// 处理代理端 WebSocket 连接生命周期
export function handleProxyConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const proxyWs = ws as ProxySocket;
  proxyWs.isAlive = true;

  proxyWs.on("pong", () => {
    proxyWs.isAlive = true;
  });

  proxyWs.on("message", (data: Buffer, isBinary: boolean) => {
    // Binary frames are pass-through; relay only reads the sessionId prefix for routing.
    if (isBinary) {
      if (data.length < 2 || data.length > MAX_BINARY_FRAME_SIZE) {
        logger.warn({ size: data.length }, "Binary frame rejected: invalid size");
        return;
      }
      const sessionIdLen = data[0];
      if (sessionIdLen === 0 || sessionIdLen > 255 || data.length < 1 + sessionIdLen) {
        logger.warn(
          { sessionIdLen, dataLen: data.length },
          "Binary frame rejected: malformed sessionId prefix",
        );
        return;
      }
      if (!proxyWs.proxyId) {
        logger.warn("Binary frame from unregistered proxy, dropped");
        return;
      }

      // Forward the original buffer, including the sessionId prefix, so clients receive exact PTY bytes.
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

      proxyWs.send(
        serializeControl({
          type: "proxy_register_response",
          status,
        }),
      );

      if (status === "reconnected") {
        notifyClientsProxyOnline(proxyId, registry, logger, chaos);
      }

      broadcastProxyList(registry, chaos);
      return;
    }

    if (result.kind === "control" && result.message.type === "proxy_disconnect") {
      if (proxyWs.proxyId) {
        notifyClientsProxyOffline(proxyWs.proxyId, registry, logger, chaos);
        registry.unregisterProxy(proxyWs.proxyId);
        logger.info(
          { proxyId: proxyWs.proxyId },
          "Proxy gracefully disconnected, resources cleaned",
        );
        proxyWs.proxyId = undefined;
        broadcastProxyList(registry, chaos);
      }
      return;
    }

    // proxy 重连后同步 session 列表，relay 据此建立 proxy-session 关联。
    if (result.kind === "control" && result.message.type === "session_sync") {
      if (!proxyWs.proxyId) return;
      const { sessions } = result.message;
      for (const s of sessions) {
        registry.addSessionToProxy(proxyWs.proxyId, s.id);
      }
      logger.info({ proxyId: proxyWs.proxyId, count: sessions.length }, "Session sync received");
      return;
    }

    // proxy 发给 client 的控制消息：直接转发给绑定的客户端，不进 session buffer
    if (result.kind === "control") {
      if (isProxyToClientRelayControlType(result.message.type)) {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        const clients = registry.getClientsForProxy(proxyWs.proxyId);
        for (const clientWs of clients) {
          if (clientWs.readyState === WebSocket.OPEN) {
            if (chaos) {
              chaos.send(clientWs, raw, {
                direction: "proxy_to_client",
                type: result.message.type,
              });
            } else {
              clientWs.send(raw);
            }
          }
        }
        logger.info(
          { proxyId: proxyWs.proxyId, type: result.message.type, clientCount: clients.length },
          "Forwarded control message from proxy to clients",
        );
        return;
      }
      // 其他控制消息代理端不应发送
      logger.warn({ type: result.message.type }, "Unexpected control message from proxy");
      return;
    }

    if (result.kind === "envelope") {
      if (!proxyWs.proxyId) {
        rejectNotRegistered(proxyWs);
        return;
      }
      routeProxyMessage(raw, proxyWs.proxyId, registry, logger, chaos);
      return;
    }

    if (result.kind === "invalid") {
      logger.error({ error: result.error, raw: raw.slice(0, 200) }, "Invalid message from proxy");
      proxyWs.send(
        JSON.stringify({
          type: "relay_error",
          code: RelayErrorCode.INVALID_MESSAGE,
          message: `${result.error} | raw: ${raw.slice(0, 200)}`,
        }),
      );
      return;
    }
  });

  proxyWs.on("close", () => {
    if (!proxyWs.proxyId) return;
    // 同 proxyId 重连场景：registerProxy 会 terminate 旧 ws、把 registry 指向新 ws，
    // 旧 ws 的 close 异步触发到达这里时，registry.getProxy(proxyId) 已是新 ws 实例。
    // 此时若仍执行 transitionProxy("online", "offline")，会把新连接的状态翻回离线并广播一次假离线。
    // 仅当 registry 当前持有的 ws 仍是我们自己（或 entry 已被 proxy_disconnect 清掉）时才走离线流程。
    const current = registry.getProxy(proxyWs.proxyId);
    if (current && current !== proxyWs) {
      logger.info(
        { proxyId: proxyWs.proxyId },
        "Old proxy ws closed after being superseded by reconnect, skipping offline transition",
      );
      return;
    }
    notifyClientsProxyOffline(proxyWs.proxyId, registry, logger, chaos);
    try {
      registry.transitionProxy(proxyWs.proxyId, "online", "offline");
    } catch {
      // proxy 已被 proxy_disconnect 清理或已离线，跳过
    }
    logger.info(
      { proxyId: proxyWs.proxyId },
      "Proxy disconnected, state preserved for reconnect",
    );
    broadcastProxyList(registry, chaos);
  });

  proxyWs.on("error", (err) => {
    logger.error({ err, proxyId: proxyWs.proxyId }, "Proxy WebSocket error");
  });
}
