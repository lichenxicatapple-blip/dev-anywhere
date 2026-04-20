import {
  MessageEnvelopeSchema,
  RelayControlSchema,
} from "@cc-anywhere/shared";
import type { RelayControlMessage } from "@cc-anywhere/shared";
import type { MessageEnvelope } from "@cc-anywhere/shared";
import { WebSocket } from "ws";
import type { Logger } from "@cc-anywhere/shared";
import type { RelayRegistry } from "./registry.js";

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
  const { sessionId } = message;

  // 跟踪该 proxy 拥有的 session
  registry.addSessionToProxy(proxyId, sessionId);

  // 转发给所有绑定的客户端
  const clients = registry.getClientsForProxy(proxyId);
  for (const clientWs of clients) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  }
}

// relay 无状态，replay_request 总是返回 gap_unrecoverable
// Phase 11 的恢复协议由 proxy 驱动，不依赖 relay 缓冲
export function handleReplayRequest(
  sessionId: string,
  fromSeq: number,
  toSeq: number | undefined,
  clientWs: WebSocket,
  _registry: RelayRegistry,
  logger: Logger,
): void {
  const effectiveToSeq = toSeq ?? 0;

  if (fromSeq > effectiveToSeq && effectiveToSeq > 0) {
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "INVALID_RANGE",
      message: `Invalid replay range: fromSeq ${fromSeq} > toSeq ${effectiveToSeq}`,
    }));
    return;
  }

  clientWs.send(JSON.stringify({
    type: "gap_unrecoverable",
    sessionId,
    fromSeq,
    toSeq: effectiveToSeq,
  }));
  logger.info({ sessionId, fromSeq, toSeq: effectiveToSeq }, "Replay request: relay is stateless, no buffer");
}

// 将 client 发来的 MessageEnvelope 转发给绑定的 proxy
// proxyId 由调用方从 clientId 绑定中解析后传入
// tool_approve/tool_deny 等信封消息直接发送到 proxy WS，不经过任何队列或缓冲
export function routeClientMessage(
  raw: string,
  proxyId: string,
  clientWs: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
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
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "PROXY_OFFLINE",
      message: `Proxy ${proxyId} is not available`,
    }));
    return;
  }

  proxyWs.send(raw);
}
