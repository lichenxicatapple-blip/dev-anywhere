import { WebSocket } from "ws";
import { isClientToProxyRelayControlType, RelayErrorCode, type Logger } from "@dev-anywhere/shared";
import { nanoid } from "nanoid";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage } from "../router.js";

// 扩展 WebSocket 实例存储客户端元数据
interface ClientSocket extends WebSocket {
  isAlive: boolean;
  clientId?: string;
  boundProxyId?: string;
}

// 处理 client_register 消息：三种状态 restored / proxy_offline / new。
// relay 不缓存输出；恢复由 proxy 重新推送 session_list/agent_status/snapshot 等状态。
function handleClientRegister(
  clientId: string,
  clientWs: ClientSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  clientWs.clientId = clientId;

  const binding = registry.getClientBinding(clientId);

  if (!binding) {
    clientWs.send(
      JSON.stringify({
        type: "client_register_response",
        status: "new",
      }),
    );
    logger.info({ clientId, status: "new" }, "Client registered");
    return;
  }

  const { proxyId } = binding;
  registry.updateClientSocket(clientId, clientWs);
  clientWs.boundProxyId = proxyId;

  if (!registry.isProxyOnline(proxyId)) {
    clientWs.send(
      JSON.stringify({
        type: "client_register_response",
        status: "proxy_offline",
        proxyId,
      }),
    );
    logger.info({ clientId, proxyId, status: "proxy_offline" }, "Client registered");
    return;
  }

  // proxy 在线，恢复绑定（relay 无状态，不做增量回放）
  clientWs.send(
    JSON.stringify({
      type: "client_register_response",
      status: "restored",
      proxyId,
    }),
  );

  logger.info({ clientId, proxyId, status: "restored" }, "Client registered");
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

  clientWs.on("message", (data: Buffer, isBinary: boolean) => {
    // Clients only send JSON control/envelope messages; binary frames from clients are ignored.
    if (isBinary) {
      return;
    }

    const raw = data.toString();
    const result = parseMessage(raw);

    if (result.kind === "control") {
      const msg = result.message;
      logger.info(
        { type: msg.type, clientId: clientWs.clientId, bound: clientWs.boundProxyId },
        "Client message received",
      );

      if (msg.type === "client_register") {
        handleClientRegister(msg.clientId, clientWs, registry, logger);
        return;
      }

      if (msg.type === "proxy_list_request") {
        const proxies = registry.listProxiesWithName().map((p) => ({
          ...p,
          sessions: registry.getSessionsForProxy(p.proxyId),
        }));
        clientWs.send(
          JSON.stringify({
            type: "proxy_list_response",
            requestId: msg.requestId,
            proxies,
          }),
        );
        return;
      }

      // client → proxy 透传：relay 不处理内容，直接转发给绑定的 proxy
      if (isClientToProxyRelayControlType(msg.type)) {
        const targetProxyId =
          ("proxyId" in msg ? (msg.proxyId as string) : undefined) || clientWs.boundProxyId;
        if (!targetProxyId) {
          clientWs.send(
            JSON.stringify({
              type: "relay_error",
              code: RelayErrorCode.NOT_BOUND,
              message: "Client is not bound to any proxy",
            }),
          );
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          proxyWs.send(raw);
        } else {
          clientWs.send(
            JSON.stringify({
              type: "relay_error",
              code: RelayErrorCode.PROXY_OFFLINE,
              message: `Proxy ${targetProxyId} is not available`,
            }),
          );
        }
        return;
      }

      if (msg.type === "proxy_select") {
        if (!registry.isProxyOnline(msg.proxyId)) {
          clientWs.send(
            JSON.stringify({
              type: "proxy_select_response",
              requestId: msg.requestId,
              success: false,
              error: `Proxy not online: ${msg.proxyId}`,
            }),
          );
          return;
        }
        // 没有 clientId 时自动分配，统一通过 clientId 绑定
        if (!clientWs.clientId) {
          clientWs.clientId = `anon-${nanoid(10)}`;
        }
        const bound = registry.bindClientById(clientWs.clientId, msg.proxyId, clientWs);
        if (!bound) {
          clientWs.send(
            JSON.stringify({
              type: "proxy_select_response",
              requestId: msg.requestId,
              success: false,
              error: `Proxy not online: ${msg.proxyId}`,
            }),
          );
          return;
        }
        clientWs.boundProxyId = msg.proxyId;
        clientWs.send(
          JSON.stringify({
            type: "proxy_select_response",
            requestId: msg.requestId,
            success: true,
            proxyId: msg.proxyId,
          }),
        );
        logger.info({ proxyId: msg.proxyId, clientId: clientWs.clientId }, "Client bound to proxy");
        return;
      }

      clientWs.send(
        JSON.stringify({
          type: "relay_error",
          code: RelayErrorCode.UNSUPPORTED,
          message: `Unsupported control message: ${msg.type}`,
        }),
      );
      return;
    }

    if (result.kind === "envelope") {
      if (!clientWs.boundProxyId) {
        clientWs.send(
          JSON.stringify({
            type: "relay_error",
            code: RelayErrorCode.NOT_BOUND,
            message: "Client is not bound to any proxy",
          }),
        );
        return;
      }
      routeClientMessage(raw, clientWs.boundProxyId, clientWs, registry, logger);
      return;
    }

    logger.error({ error: result.error, raw: raw.slice(0, 200) }, "Invalid message from client");
    clientWs.send(
      JSON.stringify({
        type: "relay_error",
        code: RelayErrorCode.INVALID_MESSAGE,
        message: `${result.error} | raw: ${raw.slice(0, 200)}`,
      }),
    );
  });

  clientWs.on("close", () => {
    registry.removeClientWs(clientWs);
    logger.info({ clientId: clientWs.clientId }, "Client disconnected");
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}
