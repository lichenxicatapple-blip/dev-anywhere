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
]);

export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
