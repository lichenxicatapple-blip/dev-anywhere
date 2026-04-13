import { z } from "zod";
import {
  TerminalFramePayloadSchema,
  PtyStatePayloadSchema,
} from "./session.js";

// 控制消息中复用的子类型
export const ProxyInfoSchema = z.object({ proxyId: z.string(), name: z.string().optional(), online: z.boolean(), sessions: z.array(z.string()).optional() });
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
});
export type HistorySession = z.infer<typeof HistorySessionSchema>;

// 中转服务器控制消息，独立于 MessageEnvelope 的传输层协议
export const RelayControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proxy_register"), proxyId: z.string().min(1), name: z.string().optional() }),
  z.object({
    type: z.literal("proxy_register_response"),
    status: z.enum(["new", "reconnected"]),
    sessions: z.record(z.string(), z.number()).optional(),
  }),
  z.object({ type: z.literal("proxy_list_request") }),
  z.object({
    type: z.literal("proxy_list_response"),
    proxies: z.array(ProxyInfoSchema),
  }),
  z.object({ type: z.literal("proxy_select"), proxyId: z.string().min(1) }),
  z.object({
    type: z.literal("proxy_select_response"),
    success: z.boolean(),
    proxyId: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("relay_error"),
    code: z.string(),
    message: z.string(),
  }),

  // 客户端注册协议
  z.object({
    type: z.literal("client_register"),
    clientId: z.string().min(1),
    // per-session lastSeq，与 proxy_register_response.sessions 对称
    // key=sessionId, value=该 session 客户端已收到的最大 seq
    // 未列出的 session 视为从未收到，回放全量
    sessions: z.record(z.string(), z.number()).optional(),
  }),
  z.object({
    type: z.literal("client_register_response"),
    status: z.enum(["restored", "proxy_offline", "new"]),
    proxyId: z.string().optional(),
    // per-session 最新 seq，client 可用于进度感知和自检
    sessions: z.record(z.string(), z.number()).optional(),
  }),

  // 消息回放协议
  z.object({
    type: z.literal("replay_request"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    // 不传则同步到该 session 的最新消息
    toSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("replay_response"),
    sessionId: z.string().min(1),
    messages: z.array(z.record(z.string(), z.unknown())),
  }),

  // Gap 检测响应
  z.object({
    type: z.literal("gap_unrecoverable"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),

  // Proxy 离线通知
  z.object({
    type: z.literal("proxy_offline"),
    proxyId: z.string(),
  }),

  // Proxy 主动断开，relay 立即清理资源
  z.object({
    type: z.literal("proxy_disconnect"),
    proxyId: z.string().min(1),
  }),

  // Proxy 重连后通知 client 恢复
  z.object({
    type: z.literal("proxy_online"),
    proxyId: z.string().min(1),
  }),

  // 目录列表请求与响应
  z.object({ type: z.literal("dir_list_request"), proxyId: z.string().min(1).optional(), path: z.string() }),
  z.object({
    type: z.literal("dir_list_response"),
    entries: z.array(DirEntrySchema),
    path: z.string(),
  }),

  // 命令列表推送，proxy 将可用命令列表推给 client
  z.object({
    type: z.literal("command_list_push"),
    commands: z.array(CommandEntrySchema),
  }),

  // 文件树推送
  z.object({
    type: z.literal("file_tree_push"),
    path: z.string(),
    entries: z.array(DirEntrySchema),
  }),

  // 会话列表请求与权限模式变更
  z.object({ type: z.literal("session_list") }),
  z.object({ type: z.literal("permission_mode_change"), mode: z.enum(["default", "auto_accept", "plan"]) }),

  // 会话历史浏览
  z.object({ type: z.literal("session_history_request") }),
  z.object({
    type: z.literal("session_history_response"),
    sessions: z.array(HistorySessionSchema),
  }),

  // PTY 实时画面推送，从 Envelope 迁移到 Control 层
  z.object({
    type: z.literal("terminal_frame"),
    sessionId: z.string(),
    payload: TerminalFramePayloadSchema,
  }),

  // PTY 语义状态，从 Envelope 迁移到 Control 层
  z.object({
    type: z.literal("pty_state"),
    sessionId: z.string(),
    payload: PtyStatePayloadSchema,
  }),

  // 终端标题变化，proxy -> client
  z.object({
    type: z.literal("terminal_title"),
    sessionId: z.string(),
    title: z.string(),
  }),

  // 终端尺寸变化，proxy -> client
  z.object({
    type: z.literal("terminal_resize"),
    sessionId: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),

  // 客户端请求当前终端全量帧，client -> proxy
  z.object({
    type: z.literal("terminal_frame_request"),
    sessionId: z.string(),
    rows: z.number().int().positive().optional(),
  }),

  // 终端滚动请求，client -> proxy，服务端维护偏移量并推回 terminal_frame
  z.object({
    type: z.literal("terminal_scroll_request"),
    sessionId: z.string(),
    direction: z.enum(["up", "down"]),
    delta: z.number().int().positive(),
    rows: z.number().int().positive().optional(),
  }),

  // proxy 重连后同步活跃 session 列表给 relay
  z.object({
    type: z.literal("session_sync"),
    sessions: z.array(z.object({
      id: z.string(),
      mode: z.enum(["pty", "json"]),
      state: z.string(),
    })),
  }),
]);

export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
