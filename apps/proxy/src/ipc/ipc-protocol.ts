import { z } from "zod";
import { SessionState } from "@cc-anywhere/shared";
import { LineBuffer } from "./line-buffer.js";

// IPC binary 帧标记字节，0x00 不可能是 JSON 行的首字节（JSON 以 '{' 开头）
export const IPC_BINARY_MARKER = 0x00;

// 编码 binary PTY 数据帧用于 IPC 传输
// 格式: [1B 0x00 marker][4B payload_len uint32LE][1B sessionId_len][sessionId UTF-8][PTY data]
export function encodeBinaryIpcFrame(sessionId: string, data: Buffer): Buffer {
  const sessionIdBuf = Buffer.from(sessionId, "utf-8");
  const payloadLen = 1 + sessionIdBuf.length + data.length;
  const frame = Buffer.alloc(1 + 4 + payloadLen);
  let offset = 0;
  frame[offset] = IPC_BINARY_MARKER;
  offset += 1;
  frame.writeUInt32LE(payloadLen, offset);
  offset += 4;
  frame[offset] = sessionIdBuf.length;
  offset += 1;
  sessionIdBuf.copy(frame, offset);
  offset += sessionIdBuf.length;
  data.copy(frame, offset);
  return frame;
}

const sessionStateValues = Object.values(SessionState) as [string, ...string[]];

// IPC 消息 schema，客户端与服务端通过 Unix domain socket 使用 NDJSON 通信
export const IpcMessageSchema = z.discriminatedUnion("type", [
  // 客户端请求创建新会话，sessionId 可选用于重连时复用
  z.object({
    type: z.literal("session_create_request"),
    name: z.string().optional(),
    mode: z.enum(["pty", "json"]),
    cwd: z.string(),
    pid: z.number(),
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
    pid: z.number(),
  }),

  // 客户端取消注册 PTY 会话
  z.object({
    type: z.literal("pty_deregister"),
    sessionId: z.string(),
  }),

  // 输入，从服务端转发到客户端的 PTY stdin（手机远程输入注入）
  z.object({
    type: z.literal("pty_input"),
    sessionId: z.string(),
    data: z.string(),
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

  // client → serve：PTY 终端帧推送，frame 是 JSON.stringify 后的 terminal_frame Control 消息
  // 客户端请求增强版服务状态（含 relay 连接信息和 worker 状态）
  z.object({
    type: z.literal("service_status_request"),
  }),

  // 服务端响应增强版服务状态
  z.object({
    type: z.literal("service_status_response"),
    relay: z
      .object({
        connected: z.boolean(),
        proxyId: z.string(),
        reconnectAttempt: z.number(),
        queueDepth: z.number(),
      })
      .nullable(),
    sessions: z.array(
      z.object({
        id: z.string(),
        mode: z.enum(["pty", "json"]),
        state: z.enum(sessionStateValues),
        createdAt: z.string(),
        name: z.string().optional(),
        hasWorker: z.boolean(),
      }),
    ),
  }),

  // terminal → serve：终端标题变化，由 xterm onTitleChange 触发
  z.object({
    type: z.literal("pty_title_change"),
    sessionId: z.string(),
    title: z.string(),
  }),

  // terminal → serve：PTY 语义状态变化，由 OSC 信号提取器检测。
  // 下面 state 枚举必须与 src/terminal/osc-extractor.ts 的 PtySemanticState 保持一致。
  z.object({
    type: z.literal("pty_state_push"),
    sessionId: z.string(),
    state: z.enum(["working", "turn_complete", "approval_wait", "mid_pause"]),
    title: z.string().optional(),
    tool: z.string().optional(),
  }),

  // terminal → serve：终端尺寸变化
  z.object({
    type: z.literal("pty_resize"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),

  // serve → terminal：请求 HeadlessTerminal serialize() 快照
  z.object({
    type: z.literal("pty_subscribe"),
    sessionId: z.string(),
  }),

  // terminal → serve：serialize() 结果
  z.object({
    type: z.literal("pty_snapshot"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    data: z.string(),
  }),

  // serve → terminal：relay 连接状态变更，供终端给用户显示 remote viewing 是否通畅
  z.object({
    type: z.literal("bridge_status"),
    connected: z.boolean(),
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
    event: z.record(z.string(), z.unknown()),
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
    input: z.record(z.string(), z.unknown()),
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

  // worker → serve: Claude 会话 ID，从 system 事件捕获用于后续 resume
  z.object({
    type: z.literal("worker_claude_session_id"),
    sessionId: z.string(),
  }),

  // serve → worker: 将指定工具加入会话白名单，后续同名工具自动审批
  z.object({
    type: z.literal("worker_whitelist_add"),
    toolName: z.string(),
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
      } else {
        stream.emit(
          "error",
          new Error(`Worker message validation failed: ${result.error.message}`),
        );
      }
    } catch (err) {
      stream.emit("error", new Error("Worker message parse error", { cause: err }));
    }
  });
  (stream as NodeJS.ReadableStream).pipe(lineBuffer);
}

export type IpcMessage = z.infer<typeof IpcMessageSchema>;

// 将 IPC 消息序列化为 NDJSON 格式的字符串
export function serializeIpc(msg: IpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

// 混合协议 IPC 读取器，支持 NDJSON 控制消息和 binary PTY 帧
// binary 帧以 0x00 开头，NDJSON 行以 '{' 开头，通过首字节区分
export function createIpcReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: IpcMessage) => void,
  onBinaryFrame?: (sessionId: string, data: Buffer) => void,
): void {
  let buf = Buffer.alloc(0);

  // 解析状态机：不断消费 buf 中的完整消息
  function drain(): void {
    while (buf.length > 0) {
      if (buf[0] === IPC_BINARY_MARKER) {
        // binary 帧: [1B marker][4B payload_len LE][payload]
        // 需要至少 5 字节才能读取 header
        if (buf.length < 5) return;
        const payloadLen = buf.readUInt32LE(1);
        const totalFrameLen = 1 + 4 + payloadLen;
        if (buf.length < totalFrameLen) return;

        // 解析 payload: [1B sessionId_len][sessionId][pty data]
        const payloadStart = 5;
        const sessionIdLen = buf[payloadStart];
        const sessionId = buf
          .subarray(payloadStart + 1, payloadStart + 1 + sessionIdLen)
          .toString("utf-8");
        const ptyData = Buffer.from(buf.subarray(payloadStart + 1 + sessionIdLen, totalFrameLen));

        if (onBinaryFrame) {
          onBinaryFrame(sessionId, ptyData);
        }

        buf = buf.subarray(totalFrameLen);
      } else {
        // NDJSON 行: 找 \n 分隔符
        const newlineIdx = buf.indexOf(0x0a); // '\n'
        if (newlineIdx === -1) return;

        const line = buf.subarray(0, newlineIdx).toString("utf-8");
        buf = buf.subarray(newlineIdx + 1);

        if (line.length === 0) continue;

        try {
          const raw = JSON.parse(line);
          const result = IpcMessageSchema.safeParse(raw);
          if (result.success) {
            onMessage(result.data);
          } else {
            stream.emit(
              "error",
              new Error(`IPC message validation failed: ${result.error.message}`),
            );
          }
        } catch (err) {
          stream.emit("error", new Error("IPC message parse error", { cause: err }));
        }
      }
    }
  }

  stream.on("data", (chunk: Buffer | string) => {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buf = Buffer.concat([buf, incoming]);
    drain();
  });
}
