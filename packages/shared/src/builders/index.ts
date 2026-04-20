import type { MessageEnvelope } from "../schemas/envelope.js";
import { MessageEnvelopeSchema } from "../schemas/envelope.js";

// 构建经过 schema 验证的消息信封
// seq 由调用方提供，必须与 EventStore per-session seq 一致，保证 proxy 和 relay 对账可靠
export function buildMessage<T extends MessageEnvelope["type"]>(
  type: T,
  sessionId: string,
  seq: number,
  payload: Extract<MessageEnvelope, { type: T }>["payload"],
  source: "proxy" | "client",
): Extract<MessageEnvelope, { type: T }> {
  const envelope = {
    seq,
    sessionId,
    type,
    payload,
    timestamp: Date.now(),
    source,
    version: "1.0",
  };
  return MessageEnvelopeSchema.parse(envelope) as Extract<MessageEnvelope, { type: T }>;
}
