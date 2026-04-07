import { z } from "zod";

// 中转服务器控制消息，独立于 MessageEnvelope 的传输层协议
export const RelayControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proxy_register"), proxyId: z.string().min(1) }),
  z.object({ type: z.literal("proxy_list_request") }),
  z.object({
    type: z.literal("proxy_list_response"),
    proxies: z.array(z.object({ proxyId: z.string() })),
  }),
  z.object({ type: z.literal("proxy_select"), proxyId: z.string().min(1) }),
  z.object({
    type: z.literal("relay_error"),
    code: z.string(),
    message: z.string(),
  }),

  // Phase 5: 客户端注册协议
  z.object({
    type: z.literal("client_register"),
    clientId: z.string().min(1),
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("client_register_response"),
    status: z.enum(["restored", "proxy_offline", "new"]),
    proxyId: z.string().optional(),
  }),

  // Phase 5: 消息回放协议
  z.object({
    type: z.literal("replay_request"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("replay_response"),
    sessionId: z.string().min(1),
    messages: z.array(z.record(z.string(), z.unknown())),
  }),

  // Phase 5: Gap 检测响应
  z.object({
    type: z.literal("gap_unrecoverable"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),

  // Phase 5: Proxy 离线通知
  z.object({
    type: z.literal("proxy_offline"),
    proxyId: z.string(),
  }),
]);

export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
