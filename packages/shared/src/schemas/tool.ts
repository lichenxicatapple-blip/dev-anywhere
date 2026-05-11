import { z } from "zod";
import { IdSchema } from "./id.js";

// 工具调用请求
export const ToolUseRequestPayloadSchema = z.object({
  toolName: z.string(),
  toolId: IdSchema,
  parameters: z.record(z.string(), z.unknown()),
});

export type ToolUseRequestPayload = z.infer<typeof ToolUseRequestPayloadSchema>;

// 工具调用批准，whitelistTool 为 true 时将该工具加入会话级白名单自动审批
export const ToolApprovePayloadSchema = z.object({
  toolId: IdSchema,
  whitelistTool: z.boolean().optional(),
});

export type ToolApprovePayload = z.infer<typeof ToolApprovePayloadSchema>;

// 工具调用拒绝
export const ToolDenyPayloadSchema = z.object({
  toolId: IdSchema,
  reason: z.string().optional(),
});

export type ToolDenyPayload = z.infer<typeof ToolDenyPayloadSchema>;

// 工具调用结果
export const ToolResultPayloadSchema = z.object({
  toolId: IdSchema,
  result: z.unknown(),
  isError: z.boolean(),
});

export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;
