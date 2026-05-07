import { z } from "zod";
import { AgentStatusPayloadSchema, PtyStatePayloadSchema } from "./session.js";
import { RelayErrorCode } from "../constants/relay-errors.js";

// 控制消息中复用的子类型
export const ProxyInfoSchema = z.object({
  proxyId: z.string(),
  name: z.string().optional(),
  online: z.boolean(),
  sessions: z.array(z.string()).optional(),
});
export type ProxyInfo = z.infer<typeof ProxyInfoSchema>;

export const DirEntrySchema = z.object({ name: z.string(), isDir: z.boolean() });
export type DirEntry = z.infer<typeof DirEntrySchema>;

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
  provider: z.enum(["claude", "codex"]).optional(),
});
export type HistorySession = z.infer<typeof HistorySessionSchema>;

type RelayControlDirection = "proxy_to_client" | "client_to_proxy";
type EmptyShape = Record<never, never>;

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
    proxyId: z.string().min(1),
    name: z.string().optional(),
  }),
  control("proxy_register_response", {
    status: z.enum(["new", "reconnected"]),
    sessions: z.record(z.string(), z.number()).optional(),
  }),
  control("proxy_list_request"),
  control("proxy_list_response", {
    proxies: z.array(ProxyInfoSchema),
  }),
  control("proxy_select", { proxyId: z.string().min(1) }),
  control("proxy_select_response", {
    success: z.boolean(),
    proxyId: z.string().optional(),
    error: z.string().optional(),
  }),
  control("relay_error", {
    code: z.enum(Object.values(RelayErrorCode) as [RelayErrorCode, ...RelayErrorCode[]]),
    message: z.string(),
  }),

  // 客户端注册协议
  control("client_register", {
    clientId: z.string().min(1),
    // per-session lastSeq，与 proxy_register_response.sessions 对称
    // key=sessionId, value=该 session 客户端已收到的最大 seq
    // 未列出的 session 视为从未收到，回放全量
    sessions: z.record(z.string(), z.number()).optional(),
  }),
  control("client_register_response", {
    status: z.enum(["restored", "proxy_offline", "new"]),
    proxyId: z.string().optional(),
    // per-session 最新 seq，client 可用于进度感知和自检
    sessions: z.record(z.string(), z.number()).optional(),
  }),

  // 消息回放协议
  control("replay_request", {
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    // 不传则同步到该 session 的最新消息
    toSeq: z.number().int().nonnegative().optional(),
  }),
  control("replay_response", {
    sessionId: z.string().min(1),
    messages: z.array(z.record(z.string(), z.unknown())),
  }),

  // Gap 检测响应
  control("gap_unrecoverable", {
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),

  // Proxy 离线通知
  control("proxy_offline", {
    proxyId: z.string(),
  }),

  // Proxy 主动断开，relay 立即清理资源
  control("proxy_disconnect", {
    proxyId: z.string().min(1),
  }),

  // Proxy 重连后通知 client 恢复
  control("proxy_online", {
    proxyId: z.string().min(1),
  }),

  // 目录列表请求与响应
  control(
    "dir_list_request",
    {
      proxyId: z.string().min(1).optional(),
      path: z.string(),
    },
    "client_to_proxy",
  ),
  control(
    "dir_list_response",
    { entries: z.array(DirEntrySchema), path: z.string() },
    "proxy_to_client",
  ),

  // 目录创建请求与响应
  control("dir_create_request", { path: z.string() }, "client_to_proxy"),
  control(
    "dir_create_response",
    { path: z.string(), success: z.boolean(), error: z.string().optional() },
    "proxy_to_client",
  ),

  // 命令列表推送，proxy 将可用命令列表推给 client
  control("command_list_push", { commands: z.array(CommandEntrySchema) }, "proxy_to_client"),

  // 文件树推送: 按目录分组, 首组 path 即为 session cwd
  // 前端直接把每组写入 tree[path], 与 dir_list_response 共享 cache slot
  control(
    "file_tree_push",
    {
      groups: z.array(
        z.object({
          path: z.string(),
          entries: z.array(DirEntrySchema),
        }),
      ),
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
      sessionId: z.string().optional(),
    },
    "client_to_proxy",
  ),

  // 会话历史浏览
  control("session_history_request", undefined, "client_to_proxy"),
  control(
    "session_history_response",
    { sessions: z.array(HistorySessionSchema) },
    "proxy_to_client",
  ),

  // PTY 语义状态，从 Envelope 迁移到 Control 层
  control(
    "pty_state",
    { sessionId: z.string(), payload: PtyStatePayloadSchema },
    "proxy_to_client",
  ),

  // Provider 语义状态，来自 Claude/Codex hook 等结构化事件，不从 PTY 字节推断
  control(
    "agent_status",
    { sessionId: z.string(), payload: AgentStatusPayloadSchema },
    "proxy_to_client",
  ),

  // 终端标题变化，proxy -> client
  control("terminal_title", { sessionId: z.string(), title: z.string() }, "proxy_to_client"),

  // 终端尺寸变化，proxy -> client
  control(
    "terminal_resize",
    { sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() },
    "proxy_to_client",
  ),
  control(
    "terminal_resize_request",
    { sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() },
    "client_to_proxy",
  ),

  // 远程终止 JSON 会话，client -> proxy
  control("session_terminate", { sessionId: z.string() }, "client_to_proxy"),

  // 中断当前 turn，client -> proxy，SIGINT 到 worker 进程让 claude CLI abort 当前流
  control("session_worker_abort", { sessionId: z.string() }, "client_to_proxy"),

  // turn 完成信号，proxy -> client，对应 claude stream-json 的 result 事件
  control(
    "turn_result",
    { sessionId: z.string(), success: z.boolean(), isError: z.boolean() },
    "proxy_to_client",
  ),

  // 客户端发送到 PTY 的原始字节（ANSI 序列），不追加换行
  control(
    "remote_input_raw",
    { sessionId: z.string().min(1), data: z.string() },
    "client_to_proxy",
  ),

  // 客户端询问 proxy 的环境信息 (home 路径等), client -> proxy -> response
  // FilePathPicker 用 homePath 作为 select 模式下的默认起点, 新建会话时打开即可浏览
  control("proxy_info_request", undefined, "client_to_proxy"),
  control("proxy_info", { homePath: z.string() }, "proxy_to_client"),

  // 远程创建 JSON 会话，client -> proxy -> response
  control(
    "session_create",
    {
      cwd: z.string(),
      provider: z.enum(["claude", "codex"]),
      mode: z.enum(["json", "pty"]).optional(),
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
      sessionId: z.string(),
      mode: z.enum(["json", "pty"]).optional(),
      provider: z.enum(["claude", "codex"]).optional(),
      ptyOwner: z.enum(["local-terminal", "proxy-hosted"]).optional(),
      error: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // 客户端请求会话历史消息，client -> proxy
  control("session_messages_request", { sessionId: z.string() }, "client_to_proxy"),

  // 客户端请求会话资源（命令列表 + 文件树），client -> proxy
  control("session_resources_request", { sessionId: z.string() }, "client_to_proxy"),

  // 客户端请求当前 provider 语义状态；不经 relay 缓存，由 proxy 返回当前值
  control("agent_status_request", { sessionId: z.string().optional() }, "client_to_proxy"),

  // 客户端确认已收到审批请求；proxy 只记录送达状态，不把它当成用户决策
  control(
    "permission_request_delivered",
    { sessionId: z.string(), requestId: z.string() },
    "client_to_proxy",
  ),

  // proxy 确认用户决策已进入 provider/worker 路径；web 用它更新审批卡片状态
  control(
    "permission_decision_result",
    {
      sessionId: z.string(),
      requestId: z.string(),
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
      sessionId: z.string(),
      approvals: z.array(
        z.object({
          requestId: z.string(),
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
      ),
    },
    "proxy_to_client",
  ),

  // 恢复会话时推送历史消息，proxy -> client
  control(
    "session_history_messages",
    {
      sessionId: z.string(),
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string(),
          timestamp: z.number().optional(),
        }),
      ),
    },
    "proxy_to_client",
  ),

  // proxy 重连后同步活跃 session 列表给 relay
  control("session_sync", {
    sessions: z.array(
      z.object({
        id: z.string(),
        mode: z.enum(["pty", "json"]),
        provider: z.enum(["claude", "codex"]),
        ptyOwner: z.enum(["local-terminal", "proxy-hosted"]).optional(),
        state: z.string(),
      }),
    ),
  }),

  // PTY 会话订阅，client -> proxy，触发 terminal serialize() 返回当前状态
  control(
    "session_subscribe",
    { sessionId: z.string(), requestId: z.string().optional() },
    "client_to_proxy",
  ),

  // PTY 会话快照，proxy -> client，serialize() 的全量终端状态
  control(
    "session_snapshot",
    {
      sessionId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
      data: z.string(),
      outputSeq: z.number().int().nonnegative(),
      requestId: z.string().optional(),
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
