// schemas
export { MessageEnvelopeSchema } from "./schemas/envelope.js";
export type { MessageEnvelope, MessageType, MessageSource } from "./schemas/envelope.js";
export {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "./schemas/chat.js";
export type { UserInputPayload, AssistantMessagePayload, ThinkingPayload } from "./schemas/chat.js";
export {
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "./schemas/tool.js";
export type {
  ToolUseRequestPayload,
  ToolApprovePayload,
  ToolDenyPayload,
  ToolResultPayload,
} from "./schemas/tool.js";
export {
  SessionInfoSchema,
  SessionCreatePayloadSchema,
  SessionListPayloadSchema,
  SessionSwitchPayloadSchema,
  SessionTerminatePayloadSchema,
  SessionStatusPayloadSchema,
  PtyStatePayloadSchema,
  AgentStatusPayloadSchema,
} from "./schemas/session.js";
export type {
  SessionInfo,
  SessionCreatePayload,
  SessionListPayload,
  SessionSwitchPayload,
  SessionTerminatePayload,
  SessionStatusPayload,
  PtyStatePayload,
  AgentStatusPayload,
} from "./schemas/session.js";
export {
  HeartbeatPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "./schemas/system.js";
export type {
  HeartbeatPayload,
  AuthPayload,
  SyncRequestPayload,
  SyncResponsePayload,
} from "./schemas/system.js";

// types
export * from "./types/index.js";

// builders
export { buildMessage } from "./builders/index.js";

// relay control
export {
  ProxyInfoSchema,
  DirEntrySchema,
  CommandEntrySchema,
  HistorySessionSchema,
  RelayControlSchema,
} from "./schemas/relay-control.js";
export type {
  ProxyInfo,
  DirEntry,
  CommandEntry,
  HistorySession,
  RelayControlMessage,
} from "./schemas/relay-control.js";

// constants
export { SessionState } from "./constants/session.js";
export { RelayErrorCode } from "./constants/relay-errors.js";

// logger
export { createLogger } from "./logger.js";
export type { Logger, CreateLoggerOptions } from "./logger.js";
