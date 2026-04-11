import {
  MessageEnvelopeSchema,
  RelayControlSchema,
} from "@cc-anywhere/shared";
import type { RelayControlMessage } from "@cc-anywhere/shared";
import type { MessageEnvelope } from "@cc-anywhere/shared";
import { WebSocket } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "./registry.js";

// 消息解析结果：控制消息、信封消息或无效消息
export type ParseResult =
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

// 将 proxy 发来的 MessageEnvelope 缓冲到 per-session buffer 后转发给绑定的 client
// 只处理 Envelope 消息，Control 消息由 handler 层处理
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
  const { sessionId, type, seq, source } = message;

  // 跟踪该 proxy 拥有的 session
  registry.addSessionToProxy(proxyId, sessionId);

  // 缓冲消息到 per-session buffer，纯追加不做压缩
  const buffer = registry.getOrCreateSessionBuffer(sessionId);
  buffer.append({ raw, seq, type, source });

  // 转发给所有绑定的客户端
  const clients = registry.getClientsForProxy(proxyId);
  for (const clientWs of clients) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  }
}

// 处理 replay_request：从 per-session 缓冲区查找请求范围内的消息并逐条发送
export function handleReplayRequest(
  sessionId: string,
  fromSeq: number,
  toSeq: number | undefined,
  clientWs: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  const buffer = registry.getSessionBuffer(sessionId);

  // toSeq 未指定时同步到该 session 的最新消息
  const effectiveToSeq = toSeq ?? (buffer ? buffer.getLastSeq() : 0);

  if (fromSeq > effectiveToSeq) {
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "INVALID_RANGE",
      message: `Invalid replay range: fromSeq ${fromSeq} > toSeq ${effectiveToSeq}`,
    }));
    return;
  }

  if (!buffer) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq: effectiveToSeq,
    }));
    logger.info({ sessionId, fromSeq, toSeq: effectiveToSeq }, "Replay request: no buffer for session");
    return;
  }

  const messages = buffer.getRange(fromSeq, effectiveToSeq);
  if (messages.length === 0) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq: effectiveToSeq,
    }));
    logger.info({ sessionId, fromSeq, toSeq: effectiveToSeq }, "Replay request: no messages in range");
    return;
  }

  // 逐条发送匹配的消息
  for (const msg of messages) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg.raw);
    }
  }

  // 检查缓冲区是否覆盖了请求范围的起始部分
  const firstBufferedSeq = messages[0].seq;
  if (firstBufferedSeq > fromSeq && clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq: firstBufferedSeq - 1,
    }));
  }

  logger.info({ sessionId, fromSeq, toSeq: effectiveToSeq, sent: messages.length }, "Replay request served");
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
