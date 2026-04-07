import {
  MessageEnvelopeSchema,
  RelayControlSchema,
} from "@cc-anywhere/shared";
import type { RelayControlMessage } from "@cc-anywhere/shared";
import type { MessageEnvelope } from "@cc-anywhere/shared";
import { WebSocket } from "ws";
import type { Logger } from "pino";
import type { RelayRegistry } from "./registry.js";
import { compressOnSnapshot, compressOnResult } from "./buffer-compressor.js";

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

// PTY 快照压缩触发类型
const SNAPSHOT_TYPE = "session_status";
// JSON turn 结束信号
const RESULT_TYPE = "tool_result";

// 将 proxy 发来的 MessageEnvelope 缓冲到 per-session buffer 后转发给绑定的 client
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

  // 缓冲消息到 per-session buffer
  const buffer = registry.getOrCreateSessionBuffer(sessionId);
  buffer.append({ raw, seq, type, source });

  // 根据消息类型触发压缩
  if (type === SNAPSHOT_TYPE) {
    compressOnSnapshot(buffer, seq);
  } else if (type === RESULT_TYPE) {
    compressOnResult(buffer, seq);
  }

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
  toSeq: number,
  clientWs: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
): void {
  if (fromSeq > toSeq) {
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "INVALID_RANGE",
      message: `Invalid replay range: fromSeq ${fromSeq} > toSeq ${toSeq}`,
    }));
    return;
  }

  const buffer = registry.getSessionBuffer(sessionId);
  if (!buffer) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq,
    }));
    logger.info({ sessionId, fromSeq, toSeq }, "Replay request: no buffer for session");
    return;
  }

  const messages = buffer.getRange(fromSeq, toSeq);
  if (messages.length === 0) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq,
    }));
    logger.info({ sessionId, fromSeq, toSeq }, "Replay request: no messages in range");
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
  if (firstBufferedSeq > fromSeq) {
    clientWs.send(JSON.stringify({
      type: "gap_unrecoverable",
      sessionId,
      fromSeq,
      toSeq: firstBufferedSeq - 1,
    }));
  }

  logger.info({ sessionId, fromSeq, toSeq, sent: messages.length }, "Replay request served");
}

// 将 client 发来的 MessageEnvelope 转发给该 client 绑定的 proxy
export function routeClientMessage(
  raw: string,
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

  const proxyId = registry.getBoundProxy(clientWs);
  if (!proxyId) {
    clientWs.send(JSON.stringify({
      type: "relay_error",
      code: "NOT_BOUND",
      message: "Client is not bound to any proxy",
    }));
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
