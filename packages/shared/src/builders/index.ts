import type { MessageEnvelope } from "../schemas/envelope.js";
import { MessageEnvelopeSchema } from "../schemas/envelope.js";

let sequenceCounter = 0;

// 生成递增的序列号
export function createSequenceId(): number {
  return sequenceCounter++;
}

// 重置序列号计数器，主要用于测试
export function resetSequenceCounter(value = 0): void {
  sequenceCounter = value;
}

// 构建经过 schema 验证的消息信封
export function buildMessage<T extends MessageEnvelope["type"]>(
  type: T,
  sessionId: string,
  payload: Extract<MessageEnvelope, { type: T }>["payload"],
  source: "proxy" | "client",
): Extract<MessageEnvelope, { type: T }> {
  const envelope = {
    seq: createSequenceId(),
    sessionId,
    type,
    payload,
    timestamp: Date.now(),
    source,
    version: "1.0",
  };
  return MessageEnvelopeSchema.parse(envelope) as Extract<
    MessageEnvelope,
    { type: T }
  >;
}
