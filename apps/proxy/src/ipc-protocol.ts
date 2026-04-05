import { z } from "zod";
import { SessionState } from "@cc-anywhere/shared";
import { LineBuffer } from "./line-buffer.js";

const sessionStateValues = Object.values(SessionState) as [string, ...string[]];

// IPC 消息 schema，客户端与服务端通过 Unix domain socket 使用 NDJSON 通信
export const IpcMessageSchema = z.discriminatedUnion("type", [
  // 客户端请求创建新会话，sessionId 可选用于重连时复用
  z.object({
    type: z.literal("session_create_request"),
    name: z.string().optional(),
    mode: z.enum(["pty", "json"]),
    sessionId: z.string().optional(),
  }),

  // 服务端响应创建会话
  z.object({
    type: z.literal("session_create_response"),
    sessionId: z.string(),
    error: z.string().optional(),
  }),

  // 客户端请求会话列表
  z.object({
    type: z.literal("session_list_request"),
  }),

  // 服务端响应会话列表
  z.object({
    type: z.literal("session_list_response"),
    sessions: z.array(
      z.object({
        id: z.string(),
        mode: z.enum(["pty", "json"]),
        state: z.enum(sessionStateValues),
        createdAt: z.string(),
        name: z.string().optional(),
      }),
    ),
  }),

  // 客户端请求终止会话
  z.object({
    type: z.literal("session_terminate_request"),
    sessionId: z.string(),
  }),

  // 服务端响应终止会话
  z.object({
    type: z.literal("session_terminate_response"),
    sessionId: z.string(),
    success: z.boolean(),
  }),

  // 客户端向服务端注册 PTY 会话
  z.object({
    type: z.literal("pty_register"),
    sessionId: z.string(),
  }),

  // 客户端取消注册 PTY 会话
  z.object({
    type: z.literal("pty_deregister"),
    sessionId: z.string(),
  }),

  // PTY 输出，从客户端转发到服务端
  z.object({
    type: z.literal("pty_output"),
    sessionId: z.string(),
    data: z.string(),
  }),

  // 输入，从服务端转发到客户端的 PTY stdin
  z.object({
    type: z.literal("pty_input"),
    sessionId: z.string(),
    data: z.string(),
  }),

  // 心跳
  z.object({
    type: z.literal("heartbeat"),
    sessionId: z.string().optional(),
  }),

  // 心跳确认
  z.object({
    type: z.literal("heartbeat_ack"),
  }),

  // 服务端广播会话状态变更
  z.object({
    type: z.literal("session_status_update"),
    sessionId: z.string(),
    state: z.enum(sessionStateValues),
  }),

  // 错误响应
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

// serve 与 session-worker 之间的通信协议
export const WorkerMessageSchema = z.discriminatedUnion("type", [
  // serve → worker: 发送用户输入给 claude
  z.object({
    type: z.literal("worker_input"),
    content: z.string(),
  }),

  // serve → worker: 停止 claude 进程
  z.object({
    type: z.literal("worker_stop"),
  }),

  // serve → worker: 工具审批响应
  z.object({
    type: z.literal("worker_approval_response"),
    requestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
  }),

  // serve → worker: 请求从指定 seq 开始回放事件日志
  z.object({
    type: z.literal("worker_replay"),
    lastSeq: z.number(),
  }),

  // worker → serve: claude 输出事件（带序列号）
  z.object({
    type: z.literal("worker_event"),
    seq: z.number(),
    event: z.record(z.unknown()),
  }),

  // worker → serve: claude 进程退出
  z.object({
    type: z.literal("worker_exit"),
    code: z.number(),
  }),

  // worker → serve: 工具审批请求
  z.object({
    type: z.literal("worker_approval_request"),
    requestId: z.string(),
    toolName: z.string(),
    input: z.record(z.unknown()),
  }),

  // worker → serve: worker 就绪，claude 已启动
  z.object({
    type: z.literal("worker_ready"),
    pid: z.number(),
  }),

  // worker → serve: 回放完成，后续为实时事件
  z.object({
    type: z.literal("worker_replay_done"),
    replayedCount: z.number(),
  }),
]);

export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export function serializeWorkerMsg(msg: WorkerMessage): string {
  return JSON.stringify(msg) + "\n";
}

export function createWorkerReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: WorkerMessage) => void,
): void {
  const lineBuffer = new LineBuffer();
  lineBuffer.on("data", (line: Buffer | string) => {
    const str = typeof line === "string" ? line : line.toString();
    if (str.length === 0) return;
    try {
      const raw = JSON.parse(str);
      const result = WorkerMessageSchema.safeParse(raw);
      if (result.success) {
        onMessage(result.data);
      }
    } catch {}
  });
  (stream as NodeJS.ReadableStream).pipe(lineBuffer);
}

export type IpcMessage = z.infer<typeof IpcMessageSchema>;

// 将 IPC 消息序列化为 NDJSON 格式的字符串
export function serializeIpc(msg: IpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

// 从可读流中读取 NDJSON 消息，通过 LineBuffer 保证完整行分割
export function createIpcReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: IpcMessage) => void,
): void {
  const lineBuffer = new LineBuffer();
  lineBuffer.on("data", (line: Buffer | string) => {
    const str = typeof line === "string" ? line : line.toString();
    if (str.length === 0) return;

    try {
      const raw = JSON.parse(str);
      const result = IpcMessageSchema.safeParse(raw);
      if (result.success) {
        onMessage(result.data);
      } else {
        console.warn("IPC message validation failed:", result.error);
      }
    } catch (err) {
      console.warn("IPC message parse error:", err);
    }
  });

  (stream as NodeJS.ReadableStream).pipe(lineBuffer);
}
