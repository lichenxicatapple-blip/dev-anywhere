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

// --include-partial-messages 开启时出现的增量事件。我们消费 content_block_delta 中的
// text_delta / thinking_delta，其余内层 event（message_start/message_delta/content_block_start 等）忽略。
// signature_delta 存在但 proxy 不转发 —— signature 是 Anthropic replay 用的加密态，对 UI 无意义。
const TextDeltaSchema = z
  .object({
    type: z.literal("text_delta"),
    text: z.string(),
  })
  .passthrough();

const ThinkingDeltaSchema = z
  .object({
    type: z.literal("thinking_delta"),
    thinking: z.string(),
  })
  .passthrough();

const SignatureDeltaSchema = z
  .object({
    type: z.literal("signature_delta"),
    signature: z.string(),
  })
  .passthrough();

export const ContentBlockDeltaSchema = z
  .object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.discriminatedUnion("type", [
      TextDeltaSchema,
      ThinkingDeltaSchema,
      SignatureDeltaSchema,
    ]),
  })
  .passthrough();

const StreamEventSchema = z
  .object({
    type: z.literal("stream_event"),
    event: z.object({ type: z.string() }).passthrough(),
  })
  .passthrough();

// permission-prompt-tool=stdio 模式下，claude 发 control_request 要求审批，
// proxy handleControlRequest 需写回 control_response 解除工具阻塞。
// subtype 目前只见过 "can_use_tool"；request.display_name / permission_suggestions /
// decision_reason / decision_reason_type / tool_use_id 是 CLI 辅助字段，审批决策只看 tool_name + input。
const CanUseToolRequestSchema = z
  .object({
    subtype: z.literal("can_use_tool"),
    tool_name: z.string(),
    input: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const ControlRequestEventSchema = z
  .object({
    type: z.literal("control_request"),
    request_id: z.string(),
    request: CanUseToolRequestSchema,
  })
  .passthrough();

// 审批结果回写 shape。proxy 自己写入 stdin，主要用于单元测试断言 wire shape 合法。
export const ControlResponseEventSchema = z
  .object({
    type: z.literal("control_response"),
    response: z
      .object({
        subtype: z.literal("success"),
        request_id: z.string(),
        response: z.discriminatedUnion("behavior", [
          z
            .object({
              behavior: z.literal("allow"),
              updatedInput: z.record(z.string(), z.unknown()),
            })
            .passthrough(),
          z
            .object({
              behavior: z.literal("deny"),
              message: z.string(),
            })
            .passthrough(),
        ]),
      })
      .passthrough(),
  })
  .passthrough();

// control_response 是 proxy 写回 claude stdin 的方向，不会出现在 stdout fixture 里；
// 但 control-request scenario 的采样脚本也把写回 shape 留在 fixture 里用于 round-trip 验证。
// 并入 union 让通用 canary "every event is known" 测试能覆盖它。
export const StreamJsonEventSchema = z.discriminatedUnion("type", [
  AssistantEventSchema,
  UserEventSchema,
  ResultEventSchema,
  StreamEventSchema,
  ControlRequestEventSchema,
  ControlResponseEventSchema,
]);

// schema discriminatedUnion 未覆盖但 proxy 明确静默忽略的 event type。
// forwardEvent 遇到这些 type 不发 warn，测试也按这份名单判断"safeParse 失败是否在意"。
// 新增一种忽略 type 时只改这里一处。
export const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set(["system", "rate_limit_event"]);
