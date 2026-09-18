import { z } from "zod";
import { IdSchema } from "./id.js";

export const ApprovalOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

export type ApprovalOptionKind = z.infer<typeof ApprovalOptionKindSchema>;

export const ApprovalOptionSchema = z.object({
  optionId: IdSchema,
  name: z.string().min(1),
  kind: ApprovalOptionKindSchema,
});

export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const CursorTodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);

export const CursorTodoSchema = z.object({
  id: IdSchema,
  content: z.string(),
  status: CursorTodoStatusSchema,
});

export type CursorTodo = z.infer<typeof CursorTodoSchema>;

export const CursorAskQuestionPromptSchema = z.object({
  type: z.literal("ask_question"),
  toolCallId: IdSchema.optional(),
  title: z.string().optional(),
  questions: z.array(
    z.object({
      id: IdSchema,
      prompt: z.string(),
      options: z.array(z.object({ id: IdSchema, label: z.string() })),
      allowMultiple: z.boolean().optional(),
    }),
  ),
});

export const CursorCreatePlanPromptSchema = z.object({
  type: z.literal("create_plan"),
  toolCallId: IdSchema.optional(),
  name: z.string().optional(),
  overview: z.string().optional(),
  plan: z.string(),
  todos: z.array(CursorTodoSchema).optional(),
  isProject: z.boolean().optional(),
  phases: z
    .array(
      z.object({
        name: z.string(),
        todos: z.array(CursorTodoSchema),
      }),
    )
    .optional(),
});

export const CursorPromptSchema = z.discriminatedUnion("type", [
  CursorAskQuestionPromptSchema,
  CursorCreatePlanPromptSchema,
]);

export type CursorPrompt = z.infer<typeof CursorPromptSchema>;

export const CursorAskQuestionAnswerSchema = z.object({
  type: z.literal("ask_question"),
  outcome: z.enum(["answered", "skipped", "cancelled"]),
  answers: z
    .array(
      z.object({
        questionId: IdSchema,
        selectedOptionIds: z.array(IdSchema),
      }),
    )
    .optional(),
  reason: z.string().optional(),
});

export const CursorCreatePlanAnswerSchema = z.object({
  type: z.literal("create_plan"),
  outcome: z.enum(["accepted", "rejected", "cancelled"]),
  reason: z.string().optional(),
});

export const CursorAnswerSchema = z.discriminatedUnion("type", [
  CursorAskQuestionAnswerSchema,
  CursorCreatePlanAnswerSchema,
]);

export type CursorAnswer = z.infer<typeof CursorAnswerSchema>;

export const CursorSessionUiSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("todos"),
    toolCallId: IdSchema.optional(),
    todos: z.array(CursorTodoSchema),
    merge: z.boolean(),
  }),
  z.object({
    kind: z.literal("task"),
    toolCallId: IdSchema.optional(),
    description: z.string(),
    prompt: z.string().optional(),
    subagentType: z.unknown().optional(),
    model: z.string().optional(),
    agentId: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    toolCallId: IdSchema.optional(),
    description: z.string(),
    filePath: z.string().optional(),
    referenceImagePaths: z.array(z.string()).optional(),
  }),
]);

export type CursorSessionUi = z.infer<typeof CursorSessionUiSchema>;

// 工具调用请求
export const ToolUseRequestPayloadSchema = z.object({
  toolName: z.string(),
  toolId: IdSchema,
  parameters: z.record(z.string(), z.unknown()),
  options: z.array(ApprovalOptionSchema).optional(),
  cursorPrompt: CursorPromptSchema.optional(),
});

export type ToolUseRequestPayload = z.infer<typeof ToolUseRequestPayloadSchema>;

// 工具调用批准，whitelistTool 为 true 时将该工具加入会话级白名单自动审批
export const ToolApprovePayloadSchema = z.object({
  toolId: IdSchema,
  whitelistTool: z.boolean().optional(),
  optionId: IdSchema.optional(),
  cursorAnswer: CursorAnswerSchema.optional(),
});

export type ToolApprovePayload = z.infer<typeof ToolApprovePayloadSchema>;

// 工具调用拒绝
export const ToolDenyPayloadSchema = z.object({
  toolId: IdSchema,
  reason: z.string().optional(),
  optionId: IdSchema.optional(),
  cursorAnswer: CursorAnswerSchema.optional(),
});

export type ToolDenyPayload = z.infer<typeof ToolDenyPayloadSchema>;

// 工具调用结果
export const ToolResultPayloadSchema = z.object({
  toolId: IdSchema,
  result: z.unknown(),
  isError: z.boolean(),
});

export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;
