import { z } from "zod";

const sessionStateValues = [
  "idle",
  "working",
  "waiting_approval",
  "error",
  "terminated",
] as const;

// 创建会话
export const SessionCreatePayloadSchema = z.object({
  name: z.string().optional(),
});

export type SessionCreatePayload = z.infer<typeof SessionCreatePayloadSchema>;

// 会话列表
export const SessionListPayloadSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      name: z.string().optional(),
      state: z.enum(sessionStateValues),
    }),
  ),
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

// PTY 终端快照，base64 编码的二进制终端状态
// relay 收到后触发缓冲区压缩，丢弃快照之前的所有消息
export const PtySnapshotPayloadSchema = z.object({
  data: z.string(),
});

export type PtySnapshotPayload = z.infer<typeof PtySnapshotPayloadSchema>;
