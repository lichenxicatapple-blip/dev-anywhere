import { z } from "zod";

const sessionStateValues = [
  "idle",
  "working",
  "waiting_approval",
  "error",
  "terminated",
] as const;

// 会话信息，用于会话列表展示
export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  state: z.enum(sessionStateValues),
  mode: z.enum(["pty", "json"]).optional(),
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

// 终端栅格帧，一个 span 表示一段同属性的文本
export const TermSpanSchema = z.object({
  text: z.string(),
  fg: z.string().optional(),
  bg: z.string().optional(),
  bold: z.boolean().optional(),
  dim: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
});
export type TermSpan = z.infer<typeof TermSpanSchema>;

export type TermLine = TermSpan[];

// 终端栅格帧负载：full 模式为完整画面，delta 模式只包含变化行
// 光标位置，相对于 viewport 左上角
export const CursorSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
}).optional();

export type Cursor = z.infer<typeof CursorSchema>;

const TerminalFrameFullSchema = z.object({
  mode: z.literal("full"),
  lines: z.array(z.array(TermSpanSchema)),
  cursor: CursorSchema,
});

const TerminalFrameDeltaSchema = z.object({
  mode: z.literal("delta"),
  lines: z.array(z.object({
    lineIndex: z.number(),
    spans: z.array(TermSpanSchema),
  })),
  cursor: CursorSchema,
});

export const TerminalFramePayloadSchema = z.discriminatedUnion("mode", [
  TerminalFrameFullSchema,
  TerminalFrameDeltaSchema,
]);
export type TerminalFramePayload = z.infer<typeof TerminalFramePayloadSchema>;
export type TerminalFrameFull = z.infer<typeof TerminalFrameFullSchema>;
export type TerminalFrameDelta = z.infer<typeof TerminalFrameDeltaSchema>;

// PTY 语义状态事件，描述当前 PTY 处于何种状态
export const PtyStatePayloadSchema = z.object({
  state: z.enum(["working", "turn_complete", "approval_wait"]),
  title: z.string().optional(),
  tool: z.string().optional(),
});
export type PtyStatePayload = z.infer<typeof PtyStatePayloadSchema>;

