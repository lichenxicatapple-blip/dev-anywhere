import type { MessageEnvelope } from "../schemas/envelope.js";
import { MessageEnvelopeSchema } from "../schemas/envelope.js";
import type { RelayControlMessage } from "../schemas/relay-control.js";

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

// 序列化 relay control 消息。借助 RelayControlMessage 这个 discriminated union，
// 调用方传入 { type, ... } 时 TypeScript 会按 type 反查出该消息允许携带的字段集，
// 替代之前散落的 sendRaw(JSON.stringify({ type: "...", ... })) 模式 —— 后者在编译期
// 完全没有约束，任何字段拼写错误 / 字段漏填都到 wire 上才暴露。
//
// 这里没有再做一次 RelayControlSchema.parse(msg)：proxy 在热路径每条 envelope 都要发，
// 重复 zod 解析对吞吐有压力；编译期类型检查已经能挡住大部分错误。
// 真要做运行时校验时，调用 RelayControlSchema.parse(msg) 再 stringify 即可。
export function serializeControl(msg: RelayControlMessage): string {
  return JSON.stringify(msg);
}
