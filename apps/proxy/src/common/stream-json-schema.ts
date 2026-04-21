import { z } from "zod";

// Claude CLI stream-json 输出的事件结构定义。
// 设计原则：
// - 已知字段严格校验，未知字段 passthrough 保证前向兼容
// - content block 单独 parse，一个未知 block type 不会导致整条 assistant 事件被丢弃
// - 新 event/block 类型加到这里后，forwardEvent 添加对应分支即可
// - 基于 ~/.claude-2.1.116 采样 fixture 验证

const TextBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

// Opus extended thinking 的 thinking 字段可能是空字符串（明文被 Anthropic 服务端 redact），
// 只在 signature 里保留加密内容。signature 始终存在于 thinking block。
const ThinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

const ToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  })
  .passthrough();

// tool_result 的 content 形状多变（string / array of nested blocks），proxy 不解析内容本身
const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

// 已知 block 类型的 discriminated union；未知 type 会 safeParse 失败，调用方应跳过而非丢整个事件
export const KnownContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);


// event 级别 schema。message.content 用 z.array(z.unknown())，不在此层 narrow content block 类型，
// 让调用方逐 block 跑 KnownContentBlockSchema.safeParse 以宽容未知 block
const AssistantEventSchema = z
  .object({
    type: z.literal("assistant"),
    message: z
      .object({
        content: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

const UserEventSchema = z
  .object({
    type: z.literal("user"),
    message: z
      .object({
        content: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

const ResultEventSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const StreamJsonEventSchema = z.discriminatedUnion("type", [
  AssistantEventSchema,
  UserEventSchema,
  ResultEventSchema,
]);

