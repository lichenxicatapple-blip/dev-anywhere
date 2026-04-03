import type { MessageEnvelope, MessageType } from "@cc-anywhere/shared";

// 类型验证：确保 shared 包的类型在 proxy 中可用
type _TypeCheck = MessageEnvelope extends { type: MessageType } ? true : never;
const _check: _TypeCheck = true;
void _check;
