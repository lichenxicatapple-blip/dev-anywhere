import { z } from "zod";
import {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "./chat.js";
import {
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "./tool.js";
import {
  SessionCreatePayloadSchema,
  SessionListPayloadSchema,
  SessionSwitchPayloadSchema,
  SessionTerminatePayloadSchema,
  SessionStatusPayloadSchema,
  PtySnapshotPayloadSchema,
  TerminalFramePayloadSchema,
  PtyStatePayloadSchema,
} from "./session.js";
import {
  HeartbeatPayloadSchema,
  ErrorPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "./system.js";

// 信封基础字段：序列号、会话ID、时间戳、来源、协议版本
const BaseEnvelopeFields = {
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  timestamp: z.number(),
  source: z.enum(["proxy", "client"]),
  version: z.string(),
};

// 18 种消息类型的 discriminatedUnion，按 type 字段区分
export const MessageEnvelopeSchema = z.discriminatedUnion("type", [
  // chat (3)
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("user_input"),
    payload: UserInputPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("assistant_message"),
    payload: AssistantMessagePayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("thinking"),
    payload: ThinkingPayloadSchema,
  }),
  // tool (4)
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("tool_use_request"),
    payload: ToolUseRequestPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("tool_approve"),
    payload: ToolApprovePayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("tool_deny"),
    payload: ToolDenyPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("tool_result"),
    payload: ToolResultPayloadSchema,
  }),
  // session (5)
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("session_create"),
    payload: SessionCreatePayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("session_list"),
    payload: SessionListPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("session_switch"),
    payload: SessionSwitchPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("session_terminate"),
    payload: SessionTerminatePayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("session_status"),
    payload: SessionStatusPayloadSchema,
  }),
  // system (5)
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("heartbeat"),
    payload: HeartbeatPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("error"),
    payload: ErrorPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("auth"),
    payload: AuthPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("sync_request"),
    payload: SyncRequestPayloadSchema,
  }),
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("sync_response"),
    payload: SyncResponsePayloadSchema,
  }),
  // PTY 终端快照，relay 收到后触发缓冲区压缩
  z.object({
    ...BaseEnvelopeFields,
    type: z.literal("pty_snapshot"),
    payload: PtySnapshotPayloadSchema,
  }),
  // Phase 6: 终端栅格帧，proxy 向 client 推送渲染好的终端画面
  z.object({
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    timestamp: z.number(),
    source: z.enum(["proxy", "client", "relay"]),
    version: z.string(),
    type: z.literal("terminal_frame"),
    payload: TerminalFramePayloadSchema,
  }),
  // Phase 6: PTY 语义状态事件，描述 PTY 当前处于何种工作状态
  z.object({
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    timestamp: z.number(),
    source: z.enum(["proxy", "client", "relay"]),
    version: z.string(),
    type: z.literal("pty_state"),
    payload: PtyStatePayloadSchema,
  }),
]);

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export type MessageType = MessageEnvelope["type"];

export type MessageSource = MessageEnvelope["source"];
