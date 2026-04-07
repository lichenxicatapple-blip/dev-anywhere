import { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage, handleReplayRequest } from "../router.js";

// 扩展 WebSocket 实例存储客户端元数据
interface ClientSocket extends WebSocket {
  isAlive: boolean;
  clientId?: string;
}

// 处理 client_register 消息：三种状态 restored / proxy_offline / new
function handleClientRegister(
  clientId: string,
  lastSeq: number,
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

  if (!registry.isProxyOnline(proxyId)) {
    clientWs.send(JSON.stringify({
      type: "client_register_response",
      status: "proxy_offline",
      proxyId,
    }));
    logger.info({ clientId, proxyId, status: "proxy_offline" }, "Client registered");
    return;
  }

  // proxy 在线，恢复绑定并发送增量回放
  clientWs.send(JSON.stringify({
    type: "client_register_response",
    status: "restored",
    proxyId,
  }));

  // 遍历 proxy 关联的所有 session，发送 lastSeq 之后的消息
  const sessionIds = registry.getSessionsForProxy(proxyId);
  for (const sessionId of sessionIds) {
    const buffer = registry.getSessionBuffer(sessionId);
    if (!buffer) continue;
    const missed = buffer.getAfterSeq(lastSeq);
    for (const msg of missed) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg.raw);
      }
    }
  }

  logger.info({ clientId, proxyId, status: "restored", lastSeq }, "Client registered");
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

      if (msg.type === "client_register") {
        handleClientRegister(msg.clientId, msg.lastSeq, clientWs, registry, logger);
        return;
      }

      if (msg.type === "replay_request") {
        handleReplayRequest(msg.sessionId, msg.fromSeq, msg.toSeq, clientWs, registry, logger);
        return;
      }

      if (msg.type === "proxy_list_request") {
        const proxies = registry.listProxies().map((id) => ({ proxyId: id }));
        clientWs.send(JSON.stringify({
          type: "proxy_list_response",
          proxies,
        }));
        return;
      }

      if (msg.type === "proxy_select") {
        if (!registry.isProxyOnline(msg.proxyId)) {
          clientWs.send(JSON.stringify({
            type: "relay_error",
            code: "PROXY_NOT_FOUND",
            message: `Proxy not online: ${msg.proxyId}`,
          }));
          return;
        }
        const bound = registry.bindClient(clientWs, msg.proxyId);
        if (!bound) {
          clientWs.send(JSON.stringify({
            type: "relay_error",
            code: "PROXY_NOT_FOUND",
            message: `Proxy not online: ${msg.proxyId}`,
          }));
          return;
        }
        // 如果有 clientId，同步更新 clientId 绑定
        if (clientWs.clientId) {
          registry.bindClientById(clientWs.clientId, msg.proxyId, clientWs);
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
    if (clientWs.clientId) {
      registry.unbindClientById(clientWs.clientId);
    }
    registry.unbindClient(clientWs);
    logger.info("Client disconnected");
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}

