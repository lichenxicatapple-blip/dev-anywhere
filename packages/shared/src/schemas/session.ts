import { z } from "zod";
import { providerValues, ptyOwnerValues, sessionModeValues } from "../constants/enums.js";

const sessionStateValues = ["idle", "working", "waiting_approval", "error", "terminated"] as const;
const agentStatusPhaseValues = [
  "idle",
  "thinking",
  "tool_use",
  "outputting",
  "waiting_permission",
  "error",
] as const;

// 会话信息，用于会话列表展示
// lastActive: 最近一次状态变更或运行时活动时间戳 (ms), 用于列表"最近活动 N 分钟前"显示, 可选
export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  state: z.enum(sessionStateValues),
  mode: z.enum(sessionModeValues).optional(),
  provider: z.enum(providerValues),
  // PTY 尺寸所有权:
  // - local-terminal: 本地 terminal 进程持有真实 PTY，Web 只按原始 cols/rows 展示
  // - proxy-hosted: serve 内托管 PTY，Web 可按视口请求 resize
  ptyOwner: z.enum(ptyOwnerValues).optional(),
  lastActive: z.number().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// 创建会话
// streamDelta: client 端系统设置"逐字流式"toggle，true 时 proxy spawn 带 --include-partial-messages
export const SessionCreatePayloadSchema = z.object({
  name: z.string().optional(),
  cwd: z.string().optional(),
  streamDelta: z.boolean().optional(),
});

export type SessionCreatePayload = z.infer<typeof SessionCreatePayloadSchema>;

// 会话列表
export const SessionListPayloadSchema = z.object({
  sessions: z.array(SessionInfoSchema),
});

export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>;

// 切换会话
export const SessionSwitchPayloadSchema = z.object({
  sessionId: z.string(),
});

export type SessionSwitchPayload = z.infer<typeof SessionSwitchPayloadSchema>;

// 终止会话
export const SessionTerminatePayloadSchema = z.object({
  sessionId: z.string(),
});

export type SessionTerminatePayload = z.infer<typeof SessionTerminatePayloadSchema>;

// 会话状态变更
// lastActive: 触发本次状态迁移或活动刷新的时间戳 (ms)，用于列表相对时间显示。
export const SessionStatusPayloadSchema = z.object({
  sessionId: z.string(),
  state: z.enum(sessionStateValues),
  lastActive: z.number(),
});

export type SessionStatusPayload = z.infer<typeof SessionStatusPayloadSchema>;

// PTY 语义状态事件，描述当前 PTY 处于何种状态
export const PtyStatePayloadSchema = z.object({
  state: z.enum(["working", "turn_complete", "approval_wait", "mid_pause"]),
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
      requestId: z.string(),
      toolName: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
    .optional(),
  permissionResolution: z
    .object({
      requestId: z.string(),
      outcome: z.enum(["allow", "deny"]),
    })
    .optional(),
  summary: z.string().optional(),
});
export type AgentStatusPayload = z.infer<typeof AgentStatusPayloadSchema>;
