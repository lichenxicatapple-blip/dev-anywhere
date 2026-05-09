import { z } from "zod";

// 心跳消息，空 payload
export const HeartbeatPayloadSchema = z.object({});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

// 认证消息，支持配对码和 token 两种方式
export const AuthPayloadSchema = z.object({
  pairingCode: z.string().optional(),
  token: z.string().optional(),
});

export type AuthPayload = z.infer<typeof AuthPayloadSchema>;

// 同步请求，客户端发送已收到的最大序列号
export const SyncRequestPayloadSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
});

export type SyncRequestPayload = z.infer<typeof SyncRequestPayloadSchema>;

// 同步响应，使用 z.unknown 数组避免循环引用；恢复协议稳定后再收紧类型
export const SyncResponsePayloadSchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())),
});

export type SyncResponsePayload = z.infer<typeof SyncResponsePayloadSchema>;
