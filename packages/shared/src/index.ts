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
export { buildMessage, serializeControl } from "./builders/index.js";

// relay control
export {
  ProxyInfoSchema,
  AgentCliAvailabilitySchema,
  AgentCliStatusSchema,
  DirEntrySchema,
  FileTreeGroupSchema,
  CommandEntrySchema,
  HistorySessionSchema,
  RelayControlSchema,
  ProxyToClientRelayControlTypes,
  isProxyToClientRelayControlType,
  ClientToProxyRelayControlTypes,
  isClientToProxyRelayControlType,
} from "./schemas/relay-control.js";
export type {
  ProxyInfo,
  AgentCliAvailability,
  AgentCliStatus,
  DirEntry,
  FileTreeGroup,
  CommandEntry,
  HistorySession,
  RelayControlMessage,
  RelayControlType,
} from "./schemas/relay-control.js";

// constants
export { SessionState } from "./constants/session.js";
export { RelayErrorCode } from "./constants/relay-errors.js";
export { ControlErrorCode } from "./constants/control-errors.js";
export type { ControlErrorCode as ControlErrorCodeType } from "./constants/control-errors.js";

// logger
export { createLogger, flushLogger } from "./logger.js";
export type { Logger, CreateLoggerOptions } from "./logger.js";

// binary PTY frame codec
export {
  encodeBinaryFrame,
  decodeBinaryFrame,
  binaryFrameHeaderLength,
} from "./binary-frame.js";
export type { DecodedBinaryFrame } from "./binary-frame.js";
