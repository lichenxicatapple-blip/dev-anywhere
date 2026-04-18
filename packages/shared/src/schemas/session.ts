import { z } from "zod";

const sessionStateValues = [
  "idle",
  "working",
  "waiting_approval",
  "error",
  "terminated",
] as const;

// 会话信息，用于会话列表展示
// lastActive: 最近一次状态变更/消息时间戳 (ms), 用于列表"N 分钟前"显示, 可选
export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  state: z.enum(sessionStateValues),
  mode: z.enum(["pty", "json"]).optional(),
  lastActive: z.number().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// 创建会话
export const SessionCreatePayloadSchema = z.object({
  name: z.string().optional(),
  cwd: z.string().optional(),
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

export type SessionTerminatePayload = z.infer<
  typeof SessionTerminatePayloadSchema
>;

// 会话状态变更
export const SessionStatusPayloadSchema = z.object({
  sessionId: z.string(),
  state: z.enum(sessionStateValues),
});

export type SessionStatusPayload = z.infer<typeof SessionStatusPayloadSchema>;

// PTY 语义状态事件，描述当前 PTY 处于何种状态
export const PtyStatePayloadSchema = z.object({
  state: z.enum(["working", "turn_complete", "approval_wait"]),
  title: z.string().optional(),
  tool: z.string().optional(),
});
export type PtyStatePayload = z.infer<typeof PtyStatePayloadSchema>;

