import { z } from "zod";
import {
  SessionState,
  encodeBinaryFrame,
  decodeBinaryFrame,
  ptySemanticStateValues,
} from "@dev-anywhere/shared";
import { LineBuffer } from "./line-buffer.js";

// IPC binary 帧标记字节，0x00 不可能是 JSON 行的首字节（JSON 以 '{' 开头）
export const IPC_BINARY_MARKER = 0x00;

// IPC binary 帧外层 = [1B marker][4B payload_len uint32LE] + 内层 PTY 帧（来自 shared/binary-frame）。
// 内层格式（[1B sid_len][sid][4B seq][data]）由 encodeBinaryFrame 统一管理，
// 避免与 hosted-pty-registry / terminal-ipc / web 各自手写偏移量分叉。
export function encodeBinaryIpcFrame(sessionId: string, data: Buffer, outputSeq: number): Buffer {
  const inner = encodeBinaryFrame(sessionId, outputSeq, data);
  const frame = Buffer.alloc(1 + 4 + inner.length);
  frame[0] = IPC_BINARY_MARKER;
  frame.writeUInt32LE(inner.length, 1);
  frame.set(inner, 5);
  return frame;
}

const sessionStateValues = Object.values(SessionState) as [SessionState, ...SessionState[]];

const ProviderHookContextSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  sessionId: z.string(),
  hookUrl: z.string(),
  marker: z.string(),
  token: z.string(),
});

// IPC 消息 schema，客户端与服务端通过 Unix domain socket 使用 NDJSON 通信
export const IpcMessageSchema = z.discriminatedUnion("type", [
  // 客户端请求创建新会话，sessionId 可选用于重连时复用
  z.object({
    type: z.literal("session_create_request"),
    name: z.string().optional(),
    mode: z.enum(["pty", "json"]),
    provider: z.enum(["claude", "codex"]),
    cwd: z.string(),
    pid: z.number(),
    sessionId: z.string().optional(),
  }),

  // 服务端响应创建会话
  z.object({
    type: z.literal("session_create_response"),
    sessionId: z.string(),
    error: z.string().optional(),
    hook: ProviderHookContextSchema.optional(),
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

  // serve → terminal：Web 端移除本地终端会话时，只断开远程视图，不杀本地 CLI。
  z.object({
    type: z.literal("pty_detach"),
    sessionId: z.string(),
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

  // 客户端请求服务状态（含 relay 连接信息和 worker 状态）
  z.object({
    type: z.literal("service_status_request"),
  }),

  // 服务端响应增强版服务状态
  z.object({
    type: z.literal("service_status_response"),
    config: z.object({
      profile: z.string().optional(),
      relayName: z.string(),
      relayNameSource: z.enum(["cli", "profile"]),
      relayUrl: z.string().optional(),
      relayUrlSource: z.enum(["env", "file", "none"]),
      relayTokenSource: z.enum(["env", "file", "none"]),
      hookPort: z.number(),
      hookPortSource: z.enum(["env", "file", "default"]),
    }),
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

  // terminal → serve：local runtime 观察到的 PTY 语义事件。
  z.object({
    type: z.literal("pty_semantic_event"),
    sessionId: z.string(),
    state: z.enum(ptySemanticStateValues),
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
    requestId: z.string().optional(),
  }),

  // terminal → serve：serialize() 结果
  z.object({
    type: z.literal("pty_snapshot"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    data: z.string(),
    outputSeq: z.number().int().nonnegative(),
    requestId: z.string().optional(),
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

  // worker → serve: 从 stream-json 的 system.init 事件捕获 Claude CLI 侧的 session ID
  // proxy 拿它来读 ~/.claude/projects/.../<id>.jsonl 历史或后续 --resume
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

// onProtocolError：单条 NDJSON 行 parse 失败 / schema 校验失败时回调（不会终止 reader）。
// 历史上这里用 stream.emit("error") 把传输层炸掉，触发 socket close 与 onDisconnect，等于让一条
// 协议层的不兼容消息把整个 session 推进 ERROR 态——这是 Claude/Codex CLI 增加新事件类型时的真实风险。
// 现在改为 callback：调用方自行决定 log + skip 还是断开，传输层保持开放。
export function createWorkerReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: WorkerMessage) => void,
  onProtocolError?: (err: Error, line: string) => void,
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
        onProtocolError?.(
          new Error(`Worker message validation failed: ${result.error.message}`),
          str,
        );
      }
    } catch (err) {
      onProtocolError?.(new Error("Worker message parse error", { cause: err }), str);
    }
  });
  (stream as NodeJS.ReadableStream).pipe(lineBuffer);
}

export type IpcMessage = z.infer<typeof IpcMessageSchema>;

// 将 IPC 消息序列化为 NDJSON 格式的字符串
export function serializeIpc(msg: IpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

// 混合协议 IPC 读取器，支持 NDJSON 控制消息和 binary PTY 帧。
// binary 帧以 0x00 开头，NDJSON 行以 '{' 开头，通过首字节区分。
// 返回 dispose 函数用于摘掉 'data' 监听，长连接可以忽略，一次性等待（如 waitForMessage）必须调用避免累积 listener 重复解析每条消息。
// 同 createWorkerReader：onProtocolError 让协议层 parse / schema 错误不再走 stream.emit("error")，
// 由调用方决定如何处理（warn-skip / disconnect）。默认 silent drop 是为了向后兼容尚未挂回调的调用点。
export function createIpcReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: IpcMessage) => void,
  onBinaryFrame?: (sessionId: string, data: Buffer, outputSeq: number) => void,
  onProtocolError?: (err: Error, line: string) => void,
): () => void {
  let buf = Buffer.alloc(0);
  let disposed = false;

  // 解析状态机：不断消费 buf 中的完整消息
  function drain(): void {
    while (buf.length > 0) {
      if (buf[0] === IPC_BINARY_MARKER) {
        // binary 帧: [1B marker][4B payload_len LE][payload]，需要至少 5 字节才能读取 header
        if (buf.length < 5) return;
        const payloadLen = buf.readUInt32LE(1);
        const totalFrameLen = 1 + 4 + payloadLen;
        if (buf.length < totalFrameLen) return;

        // payload 内层就是 shared 端定义的 PTY frame（[sid_len][sid][seq][data]），
        // 解码同样走 decodeBinaryFrame 保持单一权威。
        const decoded = decodeBinaryFrame(buf.subarray(5, totalFrameLen));
        if (decoded && onBinaryFrame) {
          // ptyData copy 保留与旧代码一致的语义：调用方拿到的是独立 Buffer，
          // 不会被后续 buf reslice 影响。
          onBinaryFrame(decoded.sessionId, Buffer.from(decoded.data), decoded.outputSeq);
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
            onProtocolError?.(
              new Error(`IPC message validation failed: ${result.error.message}`),
              line,
            );
          }
        } catch (err) {
          onProtocolError?.(new Error("IPC message parse error", { cause: err }), line);
        }
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    if (disposed) return;
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buf = Buffer.concat([buf, incoming]);
    drain();
  }

  stream.on("data", onData);

  return () => {
    disposed = true;
    stream.off("data", onData);
  };
}
