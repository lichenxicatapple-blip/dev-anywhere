import { z } from "zod";
import { IdSchema } from "./id.js";
import { AgentStatusPayloadSchema, PtyStatePayloadSchema, sessionStateValues } from "./session.js";
import { ToolApprovePayloadSchema, ToolDenyPayloadSchema } from "./tool.js";
import {
  VoiceCapabilitiesSchema,
  VoiceConfigUpdateSchema,
  VoiceProviderConfigSchema,
  VoiceSummaryReasonSchema,
  voiceRegionValues,
} from "./voice.js";
import { RelayErrorCode } from "../constants/relay-errors.js";
import { ControlErrorCode } from "../constants/control-errors.js";
import {
  providerValues,
  ptyOwnerValues,
  sessionKindValues,
  sessionModeValues,
} from "../constants/enums.js";

// 控制消息中复用的子类型
export const ProxyInfoSchema = z.object({
  proxyId: IdSchema,
  name: z.string().optional(),
  online: z.boolean(),
  sessions: z.array(z.string()).optional(),
});
export type ProxyInfo = z.infer<typeof ProxyInfoSchema>;

export const RelayClientInfoSchema = z.object({
  clientId: IdSchema,
  proxyId: IdSchema.optional(),
  connectedAt: z.number().int().nonnegative(),
  current: z.boolean().optional(),
  userAgent: z.string().optional(),
  remoteAddress: z.string().optional(),
});
export type RelayClientInfo = z.infer<typeof RelayClientInfoSchema>;

export const AgentCliAvailabilitySchema = z.object({
  available: z.boolean(),
  command: z.string().optional(),
  error: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});
export type AgentCliAvailability = z.infer<typeof AgentCliAvailabilitySchema>;

export const AgentCliStatusSchema = z.object({
  claude: AgentCliAvailabilitySchema,
  codex: AgentCliAvailabilitySchema,
});
export type AgentCliStatus = z.infer<typeof AgentCliStatusSchema>;

export const DirEntrySchema = z.object({ name: z.string(), isDir: z.boolean() });
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const FileTreeGroupSchema = z.object({
  path: z.string(),
  entries: z.array(DirEntrySchema),
});
export type FileTreeGroup = z.infer<typeof FileTreeGroupSchema>;

export const CommandEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  source: z.string(),
});
export type CommandEntry = z.infer<typeof CommandEntrySchema>;

export const HistorySessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectDir: z.string(),
  updatedAt: z.number(),
  provider: z.enum(providerValues).optional(),
  preferredMode: z.enum(sessionModeValues).optional(),
});
export type HistorySession = z.infer<typeof HistorySessionSchema>;

const SessionHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  timestamp: z.number().optional(),
  cursor: z.string().optional(),
});

type RelayControlDirection = "proxy_to_client" | "client_to_proxy";
type EmptyShape = Record<never, never>;
const RequestIdShape = { requestId: IdSchema.optional() };
const RequiredRequestIdShape = { requestId: IdSchema };
const ControlErrorCodeSchema = z.enum(
  Object.values(ControlErrorCode) as [ControlErrorCode, ...ControlErrorCode[]],
);
const RequestErrorShape = {
  error: z.string().optional(),
  errorCode: ControlErrorCodeSchema.optional(),
};
const ClipboardImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type ControlDefinition<T extends string, S extends z.ZodRawShape> = {
  type: T;
  directions: ReadonlySet<RelayControlDirection>;
  schema: z.ZodObject<{ type: z.ZodLiteral<T> } & S>;
};

function control<T extends string>(type: T): ControlDefinition<T, EmptyShape>;
function control<T extends string>(
  type: T,
  shape: undefined,
  directions: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, EmptyShape>;
function control<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, S>;
function control<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape?: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, S | EmptyShape> {
  return {
    type,
    directions: new Set(Array.isArray(directions) ? directions : directions ? [directions] : []),
    schema: z.object({
      type: z.literal(type),
      ...(shape ?? {}),
    }) as z.ZodObject<{ type: z.ZodLiteral<T> } & (S | EmptyShape)>,
  };
}

// 中转服务器控制消息，独立于 MessageEnvelope 的传输层协议
const relayControlDefinitions = [
  control("proxy_register", {
    proxyId: IdSchema,
    name: z.string().optional(),
  }),
  control("proxy_register_response", {
    status: z.enum(["new", "reconnected"]),
  }),
  control("proxy_list_request", RequestIdShape),
  control("proxy_list_response", {
    ...RequestIdShape,
    proxies: z.array(ProxyInfoSchema),
  }),
  control("relay_client_list_request", RequestIdShape),
  control("relay_client_list_response", {
    ...RequestIdShape,
    clients: z.array(RelayClientInfoSchema),
  }),
  control("relay_client_kick", { ...RequiredRequestIdShape, clientId: IdSchema }),
  control("relay_client_kick_response", {
    ...RequiredRequestIdShape,
    clientId: IdSchema,
    success: z.boolean(),
    ...RequestErrorShape,
  }),
  control("relay_client_kicked", {
    reason: z.string().optional(),
  }),
  control("proxy_select", { ...RequestIdShape, proxyId: IdSchema }),
  control("proxy_select_response", {
    ...RequestIdShape,
    success: z.boolean(),
    proxyId: IdSchema.optional(),
    ...RequestErrorShape,
  }),
  control("relay_error", {
    code: z.enum(Object.values(RelayErrorCode) as [RelayErrorCode, ...RelayErrorCode[]]),
    message: z.string(),
    // 可选 requestId: relay 把 client 发来 raw 的 requestId 字段透传回来,
    // client 侧 waitForMessage 据此把对应 pending request 立即拒掉而不必等到 timeout。
    requestId: IdSchema.optional(),
  }),

  // Voice Pilot config is relay-local: client reads/updates the relay's stored provider settings.
  control("voice_config_request", RequestIdShape),
  control("voice_config_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    config: VoiceProviderConfigSchema.optional(),
  }),
  control("voice_config_update", {
    ...RequestIdShape,
    config: VoiceConfigUpdateSchema,
  }),
  control("voice_config_update_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    success: z.boolean(),
    config: VoiceProviderConfigSchema.optional(),
  }),
  control("voice_config_test", {
    ...RequestIdShape,
    config: VoiceConfigUpdateSchema.optional(),
  }),
  control("voice_config_test_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    success: z.boolean(),
    audioBase64: z.string().optional(),
    audioSampleRate: z.number().int().positive().optional(),
    audioEncoding: z.literal("pcm_s16le").optional(),
    transcript: z.string().optional(),
  }),
  control("voice_capabilities_request", {
    ...RequestIdShape,
    region: z.enum(voiceRegionValues).optional(),
  }),
  control("voice_capabilities_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    capabilities: VoiceCapabilitiesSchema.optional(),
  }),

  // Lightweight latency probes. These measure synthetic round-trip latency for the transport
  // segments and intentionally stay separate from PTY input echo tracing.
  control("latency_web_relay_ping", RequiredRequestIdShape),
  control("latency_web_relay_pong", {
    ...RequiredRequestIdShape,
    relayNow: z.number().optional(),
  }),
  control("latency_relay_proxy_request", RequiredRequestIdShape),
  control("latency_relay_proxy_response", {
    ...RequiredRequestIdShape,
    success: z.boolean(),
    rttMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
  }),
  control("latency_relay_proxy_ping", {
    ...RequiredRequestIdShape,
    relayNow: z.number().optional(),
  }),
  control("latency_relay_proxy_pong", {
    ...RequiredRequestIdShape,
    proxyNow: z.number().optional(),
  }),
  control("latency_web_proxy_ping", RequiredRequestIdShape, "client_to_proxy"),
  control(
    "latency_web_proxy_pong",
    { ...RequiredRequestIdShape, proxyNow: z.number().optional() },
    "proxy_to_client",
  ),

  // 客户端注册协议
  control("client_register", {
    clientId: IdSchema,
  }),
  control("client_register_response", {
    status: z.enum(["restored", "proxy_offline", "new"]),
    proxyId: IdSchema.optional(),
  }),

  // Proxy 离线通知
  control("proxy_offline", {
    proxyId: IdSchema,
  }),

  // Proxy 主动断开，relay 立即清理资源
  control("proxy_disconnect", {
    proxyId: IdSchema,
  }),

  // Proxy 重连后通知 client 恢复
  control("proxy_online", {
    proxyId: IdSchema,
  }),

  // 目录列表请求与响应
  control(
    "dir_list_request",
    {
      proxyId: IdSchema.optional(),
      ...RequestIdShape,
      path: z.string(),
    },
    "client_to_proxy",
  ),
  control(
    "dir_list_response",
    { ...RequestIdShape, ...RequestErrorShape, entries: z.array(DirEntrySchema), path: z.string() },
    "proxy_to_client",
  ),

  // 目录创建请求与响应
  control("dir_create_request", { ...RequestIdShape, path: z.string() }, "client_to_proxy"),
  control(
    "dir_create_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      path: z.string(),
      success: z.boolean(),
    },
    "proxy_to_client",
  ),

  // 命令列表推送，proxy 将可用命令列表推给 client
  control("command_list_push", { commands: z.array(CommandEntrySchema) }, "proxy_to_client"),

  // 文件树推送: 按目录分组, 首组 path 即为 session cwd
  // 前端直接把每组写入 tree[path], 与 dir_list_response 共享 cache slot
  control(
    "file_tree_push",
    {
      groups: z.array(FileTreeGroupSchema),
    },
    "proxy_to_client",
  ),

  // 会话列表请求与权限模式变更
  control("session_list", undefined, ["client_to_proxy", "proxy_to_client"]),
  control(
    "permission_mode_change",
    {
      mode: z.enum(["default", "auto_accept", "plan"]),
      // sessionId 可选：传入时 proxy 按该会话的 mode 分叉（PTY 发 Tab ANSI），未传走全局日志行为
      sessionId: IdSchema.optional(),
    },
    "client_to_proxy",
  ),

  // 会话历史浏览
  control("session_history_request", RequestIdShape, "client_to_proxy"),
  control(
    "session_history_response",
    { ...RequestIdShape, sessions: z.array(HistorySessionSchema) },
    "proxy_to_client",
  ),

  // PTY 语义状态，从 Envelope 迁移到 Control 层
  control("pty_state", { sessionId: IdSchema, payload: PtyStatePayloadSchema }, "proxy_to_client"),

  // Provider 语义状态，来自 Claude/Codex hook 等结构化事件，不从 PTY 字节推断
  control(
    "agent_status",
    { sessionId: IdSchema, payload: AgentStatusPayloadSchema },
    "proxy_to_client",
  ),

  // 终端标题变化，proxy -> client
  control("terminal_title", { sessionId: IdSchema, title: z.string() }, "proxy_to_client"),

  // 终端尺寸变化，proxy -> client
  control(
    "terminal_resize",
    { sessionId: IdSchema, cols: z.number().int().positive(), rows: z.number().int().positive() },
    "proxy_to_client",
  ),
  control(
    "terminal_resize_request",
    { sessionId: IdSchema, cols: z.number().int().positive(), rows: z.number().int().positive() },
    "client_to_proxy",
  ),

  // 远程终止 JSON 会话，client -> proxy
  control("session_terminate", { sessionId: IdSchema }, "client_to_proxy"),
  control(
    "session_rename",
    { ...RequestIdShape, sessionId: IdSchema, name: z.string() },
    "client_to_proxy",
  ),
  control(
    "session_rename_response",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      success: z.boolean(),
      name: z.string().optional(),
      ...RequestErrorShape,
    },
    "proxy_to_client",
  ),

  // 中断当前 turn，client -> proxy；JSON 由 session-worker 打断 Claude 子进程并保留会话。
  control("session_worker_abort", { sessionId: IdSchema }, "client_to_proxy"),

  // turn 完成信号，proxy -> client，对应 claude stream-json 的 result 事件
  control(
    "turn_result",
    {
      sessionId: IdSchema,
      success: z.boolean(),
      isError: z.boolean(),
      // stream-json result.result 是本轮最终文本。assistant_message 流丢失或 CLI 未发增量时，
      // Web 用它作为 JSON 模式兜底展示，避免 turn 已结束但界面空白。
      result: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // 客户端发送到 PTY 的原始字节（ANSI 序列），不追加换行
  control(
    "remote_input_raw",
    { sessionId: IdSchema, data: z.string(), traceId: IdSchema.optional() },
    "client_to_proxy",
  ),
  control(
    "clipboard_image_upload",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      mimeType: ClipboardImageMimeTypeSchema,
      dataBase64: z.string().min(1),
      fileName: z.string().optional(),
    },
    "client_to_proxy",
  ),
  control(
    "clipboard_image_upload_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      success: z.boolean(),
      // success=false 时 proxy 没有有效 path 可填；保持 optional 以避免占位空字符串通过校验。
      path: z.string().optional(),
    },
    "proxy_to_client",
  ),
  control(
    "image_preview_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      path: z.string().min(1),
    },
    "client_to_proxy",
  ),
  control(
    "image_preview_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      success: z.boolean(),
      // 同 clipboard_image_upload_response：失败时 proxy 不一定有路径。
      path: z.string().optional(),
      mimeType: ClipboardImageMimeTypeSchema.optional(),
      dataBase64: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
    },
    "proxy_to_client",
  ),
  // 任意文件下载: 与 image_preview 形状对称, 只是 mimeType 不限定为图片;
  // 单租户场景下 path 任意 (不受 previewRoots 限制), 由 proxy 端 size cap 兜底。
  control(
    "file_download_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      path: z.string().min(1),
    },
    "client_to_proxy",
  ),
  control(
    "file_download_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      success: z.boolean(),
      path: z.string().optional(),
      mimeType: z.string().optional(),
      dataBase64: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
    },
    "proxy_to_client",
  ),
  // 任意文件上传: 复用 clipboard_image_upload 的形状, mimeType 放开 + fileName 必填,
  // 由 proxy 端写入 session cwd 的 .dev-anywhere/uploads/ 子目录, 返回相对路径供 web 拼成 @path。
  control(
    "file_upload_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      mimeType: z.string().min(1),
      dataBase64: z.string().min(1),
      fileName: z.string().min(1),
    },
    "client_to_proxy",
  ),
  control(
    "file_upload_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      success: z.boolean(),
      path: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // 客户端询问 proxy 的环境信息 (home 路径等), client -> proxy -> response
  // FilePathPicker 用 homePath 作为 select 模式下的默认起点, 新建会话时打开即可浏览
  control("proxy_info_request", RequestIdShape, "client_to_proxy"),
  control(
    "proxy_info",
    { ...RequestIdShape, homePath: z.string(), agentCli: AgentCliStatusSchema },
    "proxy_to_client",
  ),
  control(
    "agent_cli_config_update",
    { ...RequestIdShape, provider: z.enum(providerValues), path: z.string().min(1) },
    "client_to_proxy",
  ),
  control(
    "agent_cli_config_update_response",
    {
      ...RequestIdShape,
      provider: z.enum(providerValues),
      agentCli: AgentCliStatusSchema.optional(),
      ...RequestErrorShape,
    },
    "proxy_to_client",
  ),

  // 远程创建 JSON 会话，client -> proxy -> response
  control(
    "session_create",
    {
      ...RequestIdShape,
      kind: z.enum(sessionKindValues).optional(),
      cwd: z.string().optional(),
      name: z.string().optional(),
      provider: z.enum(providerValues).optional(),
      mode: z.enum(sessionModeValues).optional(),
      resumeSessionId: z.string().optional(),
      // 透传给 claude CLI 的 --permission-mode, undefined 时 proxy 兜底为 "default"
      permissionMode: z
        .enum(["default", "auto", "acceptEdits", "plan", "bypassPermissions", "dontAsk"])
        .optional(),
    },
    "client_to_proxy",
  ),
  control(
    "session_create_response",
    {
      ...RequestIdShape,
      // 失败路径只送 errorCode/error, sessionId 此时无语义。成功路径才有 id。
      sessionId: IdSchema.optional(),
      name: z.string().optional(),
      nameLocked: z.boolean().optional(),
      kind: z.enum(sessionKindValues).optional(),
      mode: z.enum(sessionModeValues).optional(),
      provider: z.enum(providerValues).optional(),
      ptyOwner: z.enum(ptyOwnerValues).optional(),
      ...RequestErrorShape,
    },
    "proxy_to_client",
  ),

  // 客户端请求会话历史消息，client -> proxy
  control(
    "session_messages_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      limit: z.number().int().min(1).max(200).optional(),
      before: z.string().optional(),
    },
    "client_to_proxy",
  ),

  // 客户端请求会话资源（命令列表 + 文件树），client -> proxy
  control(
    "session_resources_request",
    { ...RequestIdShape, sessionId: IdSchema },
    "client_to_proxy",
  ),
  control(
    "session_resources_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      commands: z.array(CommandEntrySchema),
      groups: z.array(FileTreeGroupSchema),
    },
    "proxy_to_client",
  ),

  // 客户端请求当前 provider 语义状态；不经 relay 缓存，由 proxy 返回当前值
  control(
    "agent_status_request",
    { ...RequestIdShape, sessionId: IdSchema.optional() },
    "client_to_proxy",
  ),
  control(
    "agent_status_response",
    {
      ...RequestIdShape,
      statuses: z.array(z.object({ sessionId: IdSchema, payload: AgentStatusPayloadSchema })),
    },
    "proxy_to_client",
  ),

  // 客户端确认已收到审批请求；proxy 只记录送达状态，不把它当成用户决策
  control(
    "permission_request_delivered",
    { sessionId: IdSchema, requestId: IdSchema },
    "client_to_proxy",
  ),
  control(
    "tool_approve",
    { sessionId: IdSchema, payload: ToolApprovePayloadSchema },
    "client_to_proxy",
  ),
  control("tool_deny", { sessionId: IdSchema, payload: ToolDenyPayloadSchema }, "client_to_proxy"),

  // proxy 确认用户决策已进入 provider/worker 路径；web 用它更新审批卡片状态
  control(
    "permission_decision_result",
    {
      sessionId: IdSchema,
      requestId: IdSchema,
      outcome: z.enum(["allow", "deny"]),
      delivered: z.boolean(),
      message: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // proxy 推送当前 pending 的工具审批列表，client 据此恢复审批卡片
  control(
    "pending_approvals_push",
    {
      sessionId: IdSchema,
      approvals: z.array(
        z.object({
          requestId: IdSchema,
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
      ),
    },
    "proxy_to_client",
  ),

  // Voice Pilot speech summaries are produced by proxy-side Claude Code so it can read project context.
  control(
    "voice_summary_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      messageId: IdSchema,
      text: z.string().min(1),
      reason: VoiceSummaryReasonSchema,
    },
    "client_to_proxy",
  ),
  control(
    "voice_summary_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      messageId: IdSchema,
      success: z.boolean(),
      summary: z.string().min(1).optional(),
    },
    "proxy_to_client",
  ),

  // 恢复会话时推送历史消息，proxy -> client
  control(
    "session_history_messages",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      before: z.string().optional(),
      messages: z.array(SessionHistoryMessageSchema),
      hasMore: z.boolean().optional(),
      nextBefore: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // proxy 重连后同步活跃 session 列表给 relay。session_sync 由 relay 自消费（更新 proxy-session
  // 关联）不转发给 client，因此**没有** direction 标注——RelayControlDirection 只描述转发流。
  control("session_sync", {
    sessions: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(sessionKindValues).optional(),
        mode: z.enum(sessionModeValues),
        provider: z.enum(providerValues),
        ptyOwner: z.enum(ptyOwnerValues).optional(),
        cwd: z.string().optional(),
        name: z.string().optional(),
        nameLocked: z.boolean().optional(),
        state: z.enum(sessionStateValues),
      }),
    ),
  }),

  // PTY 会话订阅，client -> proxy，触发 terminal serialize() 返回当前状态
  control(
    "session_subscribe",
    { sessionId: IdSchema, requestId: IdSchema.optional() },
    "client_to_proxy",
  ),

  // PTY 会话快照，proxy -> client，serialize() 的全量终端状态
  control(
    "session_snapshot",
    {
      sessionId: IdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
      data: z.string(),
      outputSeq: z.number().int().nonnegative(),
      requestId: IdSchema.optional(),
    },
    "proxy_to_client",
  ),
] as const;

const relayControlSchemas = relayControlDefinitions.map((definition) => definition.schema) as [
  (typeof relayControlDefinitions)[number]["schema"],
  ...Array<(typeof relayControlDefinitions)[number]["schema"]>,
];

export const RelayControlSchema = z.discriminatedUnion("type", relayControlSchemas);

export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
export type RelayControlType = RelayControlMessage["type"];

export const ProxyToClientRelayControlTypes = new Set(
  relayControlDefinitions
    .filter((definition) => definition.directions.has("proxy_to_client"))
    .map((definition) => definition.type),
);

export function isProxyToClientRelayControlType(type: RelayControlType): boolean {
  return ProxyToClientRelayControlTypes.has(type);
}

export const ClientToProxyRelayControlTypes = new Set(
  relayControlDefinitions
    .filter((definition) => definition.directions.has("client_to_proxy"))
    .map((definition) => definition.type),
);

export function isClientToProxyRelayControlType(type: RelayControlType): boolean {
  return ClientToProxyRelayControlTypes.has(type);
}
