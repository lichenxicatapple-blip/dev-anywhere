import { z } from "zod";
import { providerValues, ptyOwnerValues } from "../constants/enums.js";
import { ptySemanticStateValues } from "../constants/pty.js";
import { IdSchema } from "./id.js";

export const sessionStateValues = [
  "idle",
  "working",
  "compacting",
  "waiting_approval",
  "error",
  "terminated",
] as const;
const agentStatusPhaseValues = [
  "idle",
  "thinking",
  "tool_use",
  "outputting",
  "waiting_permission",
  "error",
] as const;

/**
 * 在所有会话协议中复用同一组身份约束。调用方只提供自身的公共字段，
 * 这里负责把它们与三种合法的会话形态组成严格 union。
 */
export function createSessionIdentitySchema<T extends z.ZodRawShape>(commonFields: T) {
  return z.union([
    z
      .object({
        ...commonFields,
        kind: z.literal("agent"),
        mode: z.literal("json"),
        provider: z.enum(providerValues),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        kind: z.literal("agent"),
        mode: z.literal("pty"),
        provider: z.enum(providerValues),
        ptyOwner: z.enum(ptyOwnerValues),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        kind: z.literal("terminal"),
        mode: z.literal("pty"),
        provider: z.literal("claude"),
        ptyOwner: z.literal("proxy-hosted"),
      })
      .strict(),
  ]);
}

// 会话信息，用于会话列表展示
// lastActive: 最近一次状态变更或运行时活动时间戳 (ms)，用于列表“最近活动 N 分钟前”显示。
export const SessionInfoSchema = createSessionIdentitySchema({
  sessionId: IdSchema,
  name: z.string().optional(),
  // cwd 只用于展示完整路径/tooltip，不作为前端路由或权限判断来源。
  cwd: z.string(),
  // true 表示 name 是用户显式命名，PTY UI 不再让 OSC terminal_title 覆盖它。
  nameLocked: z.boolean().optional(),
  state: z.enum(sessionStateValues),
  lastActive: z.number(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// 会话列表
export const SessionListPayloadSchema = z
  .object({
    sessions: z.array(SessionInfoSchema),
  })
  .strict();

export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>;

// 会话状态变更
// lastActive: 触发本次状态迁移或活动刷新的时间戳 (ms)，用于列表相对时间显示。
export const SessionStatusPayloadSchema = z
  .object({
    sessionId: IdSchema,
    state: z.enum(sessionStateValues),
    lastActive: z.number(),
  })
  .strict();

export type SessionStatusPayload = z.infer<typeof SessionStatusPayloadSchema>;

// PTY 语义状态事件，描述当前 PTY 处于何种状态
export const PtyStatePayloadSchema = z.object({
  state: z.enum(ptySemanticStateValues),
  seq: z.number().int().nonnegative(),
  title: z.string().optional(),
  tool: z.string().optional(),
});
export type PtyStatePayload = z.infer<typeof PtyStatePayloadSchema>;

export const AgentStatusPayloadSchema = z.object({
  provider: z.enum(providerValues),
  phase: z.enum(agentStatusPhaseValues),
  seq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  toolName: z.string().optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  permissionRequest: z
    .object({
      requestId: IdSchema,
      toolName: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
    .optional(),
  permissionResolution: z
    .object({
      requestId: IdSchema,
      outcome: z.enum(["allow", "deny"]),
    })
    .optional(),
  summary: z.string().optional(),
});
export type AgentStatusPayload = z.infer<typeof AgentStatusPayloadSchema>;
