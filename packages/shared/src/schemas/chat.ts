import { z } from "zod";

// 用户输入消息
export const UserInputPayloadSchema = z
  .object({
    text: z.string().min(1),
    messageId: z.string().min(1).optional(),
  })
  .strict();

export type UserInputPayload = z.infer<typeof UserInputPayloadSchema>;

// 助手回复全文快照。相同 turnId 只接受更高 revision，避免重连后的重复与乱序覆盖。
export const AssistantMessagePayloadSchema = z
  .object({
    turnId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    text: z.string(),
    status: z.enum(["streaming", "completed"]),
  })
  .strict();

export type AssistantMessagePayload = z.infer<typeof AssistantMessagePayloadSchema>;

// 思考过程消息
export const ThinkingPayloadSchema = z
  .object({
    text: z.string(),
  })
  .strict();

export type ThinkingPayload = z.infer<typeof ThinkingPayloadSchema>;
