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
export {
  VoiceConfigUpdateSchema,
  VoiceCapabilitiesSchema,
  VoiceOptionSchema,
  VoiceProviderConfigSchema,
  VoiceSummaryReasonSchema,
  createBundledBailianVoiceCapabilities,
  voiceOptionGenderValues,
  voiceOptionSourceValues,
  voiceProviderValues,
  voiceRegionValues,
} from "./schemas/voice.js";
export type {
  VoiceCapabilities,
  VoiceConfigUpdate,
  VoiceOption,
  VoiceProviderConfig,
  VoiceSummaryReason,
} from "./schemas/voice.js";

// types
export * from "./types/index.js";

// builders
export { buildMessage, serializeControl } from "./builders/index.js";

// slash command helpers
export { isCompactCommandText } from "./slash-commands.js";

// relay control
export {
  ProxyInfoSchema,
  RelayClientInfoSchema,
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
  RelayClientInfo,
  AgentCliAvailability,
  AgentCliStatus,
  DirEntry,
  FileTreeGroup,
  CommandEntry,
  HistorySession,
  RelayControlMessage,
  RelayControlType,
} from "./schemas/relay-control.js";
// 类型别名，便于在 handler 签名里写 ControlMessage<"tool_approve"> / Envelope<"user_input">
// 而不是冗长的 Extract<RelayControlMessage, ...>。
import type { RelayControlMessage as _RelayControlMessage } from "./schemas/relay-control.js";
import type { MessageEnvelope as _MessageEnvelope } from "./schemas/envelope.js";
export type ControlMessage<T extends _RelayControlMessage["type"]> = Extract<
  _RelayControlMessage,
  { type: T }
>;
export type Envelope<T extends _MessageEnvelope["type"]> = Extract<_MessageEnvelope, { type: T }>;

// constants
export { SessionState } from "./constants/session.js";
export { RelayErrorCode } from "./constants/relay-errors.js";
export { ControlErrorCode } from "./constants/control-errors.js";
export type { ControlErrorCode as ControlErrorCodeType } from "./constants/control-errors.js";
export {
  providerValues,
  ptyOwnerValues,
  sessionKindValues,
  sessionModeValues,
} from "./constants/enums.js";
export type { ProviderId, PtyOwner, SessionMode } from "./constants/enums.js";
export { PtySemanticState, ptySemanticStateValues } from "./constants/pty.js";
export { RelayCloseCode } from "./constants/relay-close-codes.js";

// logger 不在主入口导出: 它依赖 node:fs / node:os, 会被 vite 当作浏览器模块拉进 web bundle
// 让整个 web 启动崩。Node 端从 "@dev-anywhere/shared/logger" 子路径导入。

// binary PTY frame codec
export { encodeBinaryFrame, decodeBinaryFrame, binaryFrameHeaderLength } from "./binary-frame.js";
export type { DecodedBinaryFrame } from "./binary-frame.js";

// FSM helper (createFSM / defineFSM)
export { createFSM, defineFSM } from "./state-machine.js";
