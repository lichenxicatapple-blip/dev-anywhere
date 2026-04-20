// 从 schema 推导的类型统一导出
export type { MessageEnvelope, MessageType, MessageSource } from "../schemas/envelope.js";
export type {
  UserInputPayload,
  AssistantMessagePayload,
  ThinkingPayload,
} from "../schemas/chat.js";
export type {
  ToolUseRequestPayload,
  ToolApprovePayload,
  ToolDenyPayload,
  ToolResultPayload,
} from "../schemas/tool.js";
export type {
  SessionCreatePayload,
  SessionListPayload,
  SessionSwitchPayload,
  SessionTerminatePayload,
  SessionStatusPayload,
} from "../schemas/session.js";
export type {
  HeartbeatPayload,
  ErrorPayload,
  AuthPayload,
  SyncRequestPayload,
  SyncResponsePayload,
} from "../schemas/system.js";
