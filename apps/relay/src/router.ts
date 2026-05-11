import { MessageEnvelopeSchema, RelayControlSchema, RelayErrorCode } from "@dev-anywhere/shared";
import type { RelayControlMessage } from "@dev-anywhere/shared";
import type { MessageEnvelope } from "@dev-anywhere/shared";
import { WebSocket } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayRegistry } from "./registry.js";
import type { RelayChaos } from "./chaos.js";

// 消息解析结果：控制消息、信封消息或无效消息
type ParseResult =
  | { kind: "control"; message: RelayControlMessage }
  | { kind: "envelope"; message: MessageEnvelope; raw: string }
  | { kind: "invalid"; error: string };

// 解析 WebSocket 消息，按优先级尝试 RelayControl 和 MessageEnvelope
export function parseMessage(data: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "invalid", error: "Invalid JSON" };
  }

  const controlResult = RelayControlSchema.safeParse(parsed);
  if (controlResult.success) {
    return { kind: "control", message: controlResult.data };
  }

  const envelopeResult = MessageEnvelopeSchema.safeParse(parsed);
  if (envelopeResult.success) {
    return { kind: "envelope", message: envelopeResult.data, raw: data };
  }

  return { kind: "invalid", error: "Message matches neither RelayControl nor MessageEnvelope" };
}

// 将 proxy 发来的 MessageEnvelope 转发给绑定的 client
// relay 无状态，不缓冲消息，直接透传
export function routeProxyMessage(
  raw: string,
  proxyId: string,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const result = parseMessage(raw);

  if (result.kind === "invalid") {
    logger.warn({ proxyId, error: result.error }, "Invalid message from proxy");
    return;
  }

  if (result.kind === "control") {
    logger.warn({ proxyId }, "Control message in routeProxyMessage, should be handled by handler");
    return;
  }

  const { message } = result;

  // session-scoped envelope 在 proxy 与 sessionId 间建立关联; 全局广播 (session_list /
  // heartbeat / auth / sync_*) 没有 sessionId, 直接广播给所有 client。
  if ("sessionId" in message) {
    registry.addSessionToProxy(proxyId, message.sessionId);
  }

  // 转发给所有绑定的客户端
  const clients = registry.getClientsForProxy(proxyId);
  for (const clientWs of clients) {
    if (clientWs.readyState === WebSocket.OPEN) {
      if (chaos) chaos.send(clientWs, raw, { direction: "proxy_to_client", type: message.type });
      else clientWs.send(raw);
    }
  }
}

// 将 client 发来的 MessageEnvelope 转发给绑定的 proxy
// proxyId 由调用方从 clientId 绑定中解析后传入
export function routeClientMessage(
  raw: string,
  proxyId: string,
  clientWs: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const result = parseMessage(raw);

  if (result.kind === "invalid") {
    logger.warn({ error: result.error }, "Invalid message from client");
    return;
  }

  if (result.kind === "control") {
    logger.warn("Control message in routeClientMessage, should be handled by handler");
    return;
  }

  const proxyWs = registry.getProxy(proxyId);
  if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
    clientWs.send(
      JSON.stringify({
        type: "relay_error",
        code: RelayErrorCode.PROXY_OFFLINE,
        message: `Proxy ${proxyId} is not available`,
      }),
    );
    return;
  }

  if (chaos) chaos.send(proxyWs, raw, { direction: "client_to_proxy", type: result.message.type });
  else proxyWs.send(raw);
}
