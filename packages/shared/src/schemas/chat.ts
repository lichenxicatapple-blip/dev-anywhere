import { z } from "zod";

// 用户输入消息
export const UserInputPayloadSchema = z.object({
  text: z.string().min(1),
});

export type UserInputPayload = z.infer<typeof UserInputPayloadSchema>;

// 助手回复消息，isPartial 标识是否为流式中间结果
export const AssistantMessagePayloadSchema = z.object({
  text: z.string(),
  isPartial: z.boolean(),
});

export type AssistantMessagePayload = z.infer<
  typeof AssistantMessagePayloadSchema
>;

// 思考过程消息
export const ThinkingPayloadSchema = z.object({
  text: z.string(),
});

export type ThinkingPayload = z.infer<typeof ThinkingPayloadSchema>;
