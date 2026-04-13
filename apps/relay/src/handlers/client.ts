import { WebSocket } from "ws";
import type { Logger } from "@cc-anywhere/shared";
import { nanoid } from "nanoid";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage, handleReplayRequest } from "../router.js";

// client → proxy 透传的控制消息类型，relay 不处理内容，直接转发
const CLIENT_TO_PROXY_TYPES = new Set([
  "dir_list_request",
  "terminal_frame_request",
  "terminal_scroll_request",
  "session_list",
  "session_history_request",
  "permission_mode_change",
]);

// 扩展 WebSocket 实例存储客户端元数据
interface ClientSocket extends WebSocket {
  isAlive: boolean;
  clientId?: string;
  boundProxyId?: string;
}

// 处理 client_register 消息：三种状态 restored / proxy_offline / new
// sessions 是 per-session lastSeq map，未列出的 session 视为从未收到（回放全量）
function handleClientRegister(
  clientId: string,
  sessions: Record<string, number> | undefined,
  clientWs: ClientSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  clientWs.clientId = clientId;

  const binding = registry.getClientBinding(clientId);

  if (!binding) {
    clientWs.send(JSON.stringify({
      type: "client_register_response",
      status: "new",
    }));
    logger.info({ clientId, status: "new" }, "Client registered");
    return;
  }

  const { proxyId } = binding;
  registry.updateClientSocket(clientId, clientWs);
  clientWs.boundProxyId = proxyId;

  const sessionSeqMap = registry.getSessionSeqMap(proxyId);

  if (!registry.isProxyOnline(proxyId)) {
    clientWs.send(JSON.stringify({
      type: "client_register_response",
      status: "proxy_offline",
      proxyId,
      sessions: sessionSeqMap,
    }));
    logger.info({ clientId, proxyId, status: "proxy_offline" }, "Client registered");
    return;
  }

  // proxy 在线，恢复绑定并发送增量回放
  clientWs.send(JSON.stringify({
    type: "client_register_response",
    status: "restored",
    proxyId,
    sessions: sessionSeqMap,
  }));

  // 按 session 独立回放，每个 session 使用各自的 lastSeq
  const proxySessionIds = registry.getSessionsForProxy(proxyId);
  for (const sessionId of proxySessionIds) {
    const buffer = registry.getSessionBuffer(sessionId);
    if (!buffer) continue;
    // 未列出的 session 用 -1，回放该 session 全量消息
    const lastSeq = sessions?.[sessionId] ?? -1;
    const missed = buffer.getAfterSeq(lastSeq);
    for (const msg of missed) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg.raw);
      }
    }
  }

  logger.info({ clientId, proxyId, status: "restored", sessions }, "Client registered");
}

// 处理远程客户端 WebSocket 连接生命周期
export function handleClientConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  const clientWs = ws as ClientSocket;
  clientWs.isAlive = true;
  registry.addClientWs(clientWs);

  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  clientWs.on("message", (data) => {
    const raw = data.toString();
    const result = parseMessage(raw);

    if (result.kind === "control") {
      const msg = result.message;

      if (msg.type === "client_register") {
        handleClientRegister(msg.clientId, msg.sessions, clientWs, registry, logger);
        return;
      }

      if (msg.type === "replay_request") {
        handleReplayRequest(msg.sessionId, msg.fromSeq, msg.toSeq, clientWs, registry, logger);
        return;
      }

      if (msg.type === "proxy_list_request") {
        const proxies = registry.listProxiesWithName().map(p => ({
          ...p,
          sessions: registry.getSessionsForProxy(p.proxyId),
        }));
        clientWs.send(JSON.stringify({
          type: "proxy_list_response",
          proxies,
        }));
        return;
      }

      // client → proxy 透传：relay 不处理内容，直接转发给绑定的 proxy
      if (CLIENT_TO_PROXY_TYPES.has(msg.type)) {
        const targetProxyId = ("proxyId" in msg ? msg.proxyId as string : undefined) || clientWs.boundProxyId;
        if (!targetProxyId) {
          clientWs.send(JSON.stringify({ type: "relay_error", code: "NOT_BOUND", message: "Client is not bound to any proxy" }));
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          proxyWs.send(raw);
        } else {
          clientWs.send(JSON.stringify({
            type: "relay_error",
            code: "PROXY_OFFLINE",
            message: `Proxy ${targetProxyId} is not available`,
          }));
        }
        return;
      }

      if (msg.type === "proxy_select") {
        if (!registry.isProxyOnline(msg.proxyId)) {
          clientWs.send(JSON.stringify({
            type: "proxy_select_response",
            success: false,
            error: `Proxy not online: ${msg.proxyId}`,
          }));
          return;
        }
        // 没有 clientId 时自动分配，统一通过 clientId 绑定
        if (!clientWs.clientId) {
          clientWs.clientId = `anon-${nanoid(10)}`;
        }
        const bound = registry.bindClientById(clientWs.clientId, msg.proxyId, clientWs);
        if (!bound) {
          clientWs.send(JSON.stringify({
            type: "proxy_select_response",
            success: false,
            error: `Proxy not online: ${msg.proxyId}`,
          }));
          return;
        }
        clientWs.boundProxyId = msg.proxyId;
        clientWs.send(JSON.stringify({
          type: "proxy_select_response",
          success: true,
          proxyId: msg.proxyId,
        }));
        logger.info({ proxyId: msg.proxyId, clientId: clientWs.clientId }, "Client bound to proxy");
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
      if (!clientWs.boundProxyId) {
        clientWs.send(JSON.stringify({
          type: "relay_error",
          code: "NOT_BOUND",
          message: "Client is not bound to any proxy",
        }));
        return;
      }
      routeClientMessage(raw, clientWs.boundProxyId, clientWs, registry, logger);
      return;
    }

    logger.error({ error: result.error, raw: raw.slice(0, 200) }, "Invalid message from client");
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "INVALID_MESSAGE",
      message: result.error,
    }));
  });

  clientWs.on("close", () => {
    registry.removeClientWs(clientWs);
    if (clientWs.clientId) {
      registry.unbindClientById(clientWs.clientId);
    }
    logger.info({ clientId: clientWs.clientId }, "Client disconnected");
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}

