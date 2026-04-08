// schemas
export { MessageEnvelopeSchema } from "./schemas/envelope.js";
export type {
  MessageEnvelope,
  MessageType,
  MessageSource,
} from "./schemas/envelope.js";
export {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "./schemas/chat.js";
export type {
  UserInputPayload,
  AssistantMessagePayload,
  ThinkingPayload,
} from "./schemas/chat.js";
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
  SessionCreatePayloadSchema,
  SessionListPayloadSchema,
  SessionSwitchPayloadSchema,
  SessionTerminatePayloadSchema,
  SessionStatusPayloadSchema,
  TermSpanSchema,
  TerminalFramePayloadSchema,
  PtyStatePayloadSchema,
} from "./schemas/session.js";
export type {
  SessionCreatePayload,
  SessionListPayload,
  SessionSwitchPayload,
  SessionTerminatePayload,
  SessionStatusPayload,
  TermSpan,
  TerminalFramePayload,
  PtyStatePayload,
} from "./schemas/session.js";
export {
  HeartbeatPayloadSchema,
  ErrorPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "./schemas/system.js";
export type {
  HeartbeatPayload,
  ErrorPayload,
  AuthPayload,
  SyncRequestPayload,
  SyncResponsePayload,
} from "./schemas/system.js";

// types
export * from "./types/index.js";

// builders
export { buildMessage } from "./builders/index.js";

// relay control
export { RelayControlSchema } from "./schemas/relay-control.js";
export type { RelayControlMessage } from "./schemas/relay-control.js";

// constants
export { ErrorCode } from "./constants/errors.js";
export { SessionState } from "./constants/session.js";
