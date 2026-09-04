import { z } from "zod";
import { MESSAGE_ENVELOPE_VERSION } from "../constants/envelope.js";
import { IdSchema } from "./id.js";
import {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "./chat.js";
import { ToolUseRequestPayloadSchema, ToolResultPayloadSchema } from "./tool.js";
import { SessionListPayloadSchema, SessionStatusPayloadSchema } from "./session.js";
import {
  HeartbeatPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "./system.js";

// 信封基础字段：序列号、时间戳、来源、协议版本——所有 envelope 共用。
const BaseEnvelopeFields = {
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  source: z.enum(["proxy", "client"]),
  version: z.literal(MESSAGE_ENVELOPE_VERSION),
};

// session-scoped envelope: 携带 sessionId 路由到具体会话, 大多数业务 envelope 走这里。
const SessionedEnvelopeFields = {
  ...BaseEnvelopeFields,
  sessionId: IdSchema,
};

// 按 type 字段区分的 discriminatedUnion 信封
export const MessageEnvelopeSchema = z.discriminatedUnion("type", [
  // chat (3)
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("user_input"),
      payload: UserInputPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("assistant_message"),
      payload: AssistantMessagePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("thinking"),
      payload: ThinkingPayloadSchema,
    })
    .strict(),
  // tool (4): 工具审批决策属于 relay control，不进入会话消息信封。
  // tool_use_request: 审批流请求（proxy → client），toolId 是 approval requestId
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("tool_use_request"),
      payload: ToolUseRequestPayloadSchema,
    })
    .strict(),
  // tool_result: 工具执行结果（proxy → client），toolId 对应 assistant_tool_use / tool_use_request 的 toolId
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("tool_result"),
      payload: ToolResultPayloadSchema,
    })
    .strict(),
  // assistant_tool_use: 纯展示型工具调用（proxy → client），区别于 tool_use_request 无审批语义
  // payload 结构复用 ToolUseRequestPayloadSchema；toolId 是 Claude 分配的 tool_use id
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("assistant_tool_use"),
      payload: ToolUseRequestPayloadSchema,
    })
    .strict(),
  // session (2)
  // session_list 是全局广播 (列出所有 session), 不绑定具体 sessionId, 不携带该字段。
  z
    .object({
      ...BaseEnvelopeFields,
      type: z.literal("session_list"),
      payload: SessionListPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...SessionedEnvelopeFields,
      type: z.literal("session_status"),
      payload: SessionStatusPayloadSchema,
    })
    .strict(),
  // system (5): 心跳 / 认证 / 同步——全局, 无 sessionId
  z
    .object({
      ...BaseEnvelopeFields,
      type: z.literal("heartbeat"),
      payload: HeartbeatPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...BaseEnvelopeFields,
      type: z.literal("auth"),
      payload: AuthPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...BaseEnvelopeFields,
      type: z.literal("sync_request"),
      payload: SyncRequestPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...BaseEnvelopeFields,
      type: z.literal("sync_response"),
      payload: SyncResponsePayloadSchema,
    })
    .strict(),
]);

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export type MessageType = MessageEnvelope["type"];

export type MessageSource = MessageEnvelope["source"];
