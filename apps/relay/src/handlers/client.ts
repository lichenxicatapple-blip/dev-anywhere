import { WebSocket } from "ws";
import {
  ControlErrorCode,
  isClientToProxyRelayControlType,
  RelayErrorCode,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import { nanoid } from "nanoid";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage } from "../router.js";
import type { RelayChaos } from "../chaos.js";
import { handleVoiceConfigControl } from "../voice/client-controls.js";
import type { VoiceConfigStore } from "../voice/config-store.js";
import type { VoiceProviderRegistry } from "../voice/provider.js";

// JSON 控制消息最大允许长度（1MB）。挡住 wire 上来的恶意超长 JSON 在 parse 前就 OOM。
const MAX_JSON_MESSAGE_SIZE = 1 * 1024 * 1024;

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

function rejectNotBound(ws: ClientSocket): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      code: RelayErrorCode.NOT_BOUND,
      message: "Client is not bound to any proxy",
    }),
  );
}

function rejectProxySelect(ws: ClientSocket, requestId: string | undefined, proxyId: string): void {
  ws.send(
    JSON.stringify({
      type: "proxy_select_response",
      requestId,
      success: false,
      errorCode: ControlErrorCode.PROXY_OFFLINE,
      error: `Proxy not online: ${proxyId}`,
    }),
  );
}

// 处理远程客户端 WebSocket 连接生命周期
export function handleClientConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
  voiceConfigStore?: VoiceConfigStore,
  voiceProviders?: VoiceProviderRegistry,
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

    if (data.length > MAX_JSON_MESSAGE_SIZE) {
      logger.warn(
        { size: data.length, clientId: clientWs.clientId },
        "JSON message rejected: exceeds max size",
      );
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
        const response = JSON.stringify({
          type: "proxy_list_response",
          requestId: msg.requestId,
          proxies,
        });
        if (chaos) {
          chaos.send(clientWs, response, {
            direction: "proxy_to_client",
            type: "proxy_list_response",
          });
        } else {
          clientWs.send(response);
        }
        return;
      }

      if (
        voiceConfigStore &&
        handleVoiceConfigControl(msg, clientWs, voiceConfigStore, logger, voiceProviders)
      ) {
        return;
      }

      // client → proxy 透传：relay 不处理内容，直接转发给绑定的 proxy。
      // 路由 key 永远是 clientWs.boundProxyId, 不能被消息字段里 client 自填的 proxyId 覆盖
      // (那条路径让绑到 p1 的 client 通过 dir_list_request{proxyId:"p2"} 读到别的 proxy 的目录)。
      if (isClientToProxyRelayControlType(msg.type)) {
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId) {
          rejectNotBound(clientWs);
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          if (chaos) chaos.send(proxyWs, raw, { direction: "client_to_proxy", type: msg.type });
          else proxyWs.send(raw);
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
          rejectProxySelect(clientWs, msg.requestId, msg.proxyId);
          return;
        }
        // 没有 clientId 时自动分配，统一通过 clientId 绑定
        if (!clientWs.clientId) {
          clientWs.clientId = `anon-${nanoid(10)}`;
        }
        const bound = registry.bindClientById(clientWs.clientId, msg.proxyId, clientWs);
        if (!bound) {
          rejectProxySelect(clientWs, msg.requestId, msg.proxyId);
          return;
        }
        clientWs.boundProxyId = msg.proxyId;
        const response = JSON.stringify({
          type: "proxy_select_response",
          requestId: msg.requestId,
          success: true,
          proxyId: msg.proxyId,
        });
        if (chaos) {
          chaos.send(clientWs, response, {
            direction: "proxy_to_client",
            type: "proxy_select_response",
          });
        } else {
          clientWs.send(response);
        }
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
        rejectNotBound(clientWs);
        return;
      }
      routeClientMessage(raw, clientWs.boundProxyId, clientWs, registry, logger, chaos);
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
    // 清掉 binding.ws 引用：保留绑定关系（重连时还能恢复 proxyId 关联），但释放对已关闭 ws 对象的强引用，
    // 避免高频重连下 clientBindings Map 长期持有死 ws 对象阻止 GC，同时让 countClients 数字不再虚高。
    if (clientWs.clientId) {
      registry.unbindClientById(clientWs.clientId);
    }
    logger.info({ clientId: clientWs.clientId }, "Client disconnected");
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}
