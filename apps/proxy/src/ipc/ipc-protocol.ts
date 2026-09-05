import { z } from "zod";
import {
  ControlErrorCode,
  ApprovalOptionSchema,
  encodeBinaryFrame,
  decodeBinaryFrame,
  providerValues,
  ptySemanticStateValues,
} from "@dev-anywhere/shared";
import { LineBuffer } from "./line-buffer.js";

// IPC binary 帧标记字节，0x00 不可能是 JSON 行的首字节（JSON 以 '{' 开头）
export const IPC_BINARY_MARKER = 0x00;

// JSON session worker 与 daemon 的独立协议版本。只在 WorkerMessage 协议不兼容时递增，
// 不与 npm 包的 patch/minor 版本绑定。
export const WORKER_IPC_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_IPC_PROTOCOL_VERSION = 2 as const;

// IPC binary 帧外层 = [1B marker][4B payload_len uint32LE] + 内层 PTY 帧（来自 shared/binary-frame）。
// 内层格式（[1B sid_len][sid][4B seq][data]）由 encodeBinaryFrame 统一管理，
// 各个传输端共用同一帧布局。
export function encodeBinaryIpcFrame(sessionId: string, data: Buffer, outputSeq: number): Buffer {
  const inner = encodeBinaryFrame(sessionId, outputSeq, data);
  const frame = Buffer.alloc(1 + 4 + inner.length);
  frame[0] = IPC_BINARY_MARKER;
  frame.writeUInt32LE(inner.length, 1);
  frame.set(inner, 5);
  return frame;
}

const ProviderHookContextSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    sessionId: z.string(),
    hookUrl: z.string(),
    marker: z.string(),
    token: z.string(),
  })
  .strict();

const terminalSessionCreateFields = {
  type: z.literal("session_create_request"),
  name: z.string().optional(),
  mode: z.literal("pty"),
  cwd: z.string().min(1),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  protocolVersion: z.literal(TERMINAL_IPC_PROTOCOL_VERSION),
  sessionId: z.string().min(1).optional(),
};

const TerminalSessionCreateRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...terminalSessionCreateFields,
      kind: z.literal("agent"),
      provider: z.enum(providerValues),
    })
    .strict(),
  z
    .object({
      ...terminalSessionCreateFields,
      kind: z.literal("terminal"),
      provider: z.literal("claude"),
    })
    .strict(),
]);

const TerminalSessionCreateResponseSchema = z.discriminatedUnion("success", [
  // Responses may add descriptive fields within the same protocol generation. Validate known
  // fields and discard extensions, while rejecting fields that contradict the success branch.
  z.object({
    type: z.literal("session_create_response"),
    success: z.literal(true),
    sessionId: z.string().min(1),
    protocolVersion: z.literal(TERMINAL_IPC_PROTOCOL_VERSION),
    hook: ProviderHookContextSchema.optional(),
    error: z.never().optional(),
  }),
  z.object({
    type: z.literal("session_create_response"),
    success: z.literal(false),
    protocolVersion: z.literal(TERMINAL_IPC_PROTOCOL_VERSION),
    error: z.string().min(1),
    sessionId: z.never().optional(),
    hook: z.never().optional(),
  }),
]);

// IPC 消息 schema，客户端与服务端通过 Unix domain socket 使用 NDJSON 通信
export const IpcMessageSchema = z.discriminatedUnion("type", [
  // 客户端请求创建新会话，sessionId 可选用于重连时复用
  TerminalSessionCreateRequestSchema,

  // 服务端响应创建会话
  TerminalSessionCreateResponseSchema,

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
    exitCode: z.number().int().optional(),
    errorTail: z.string().max(2048).optional(),
    runtimeError: z
      .discriminatedUnion("errorCode", [
        z.object({
          errorCode: z.literal(ControlErrorCode.SESSION_ALREADY_ACTIVE),
          nativeSessionId: z.string(),
        }),
        z.object({
          errorCode: z.literal(ControlErrorCode.PROCESS_START_FAILED),
          error: z.string().max(2048),
        }),
      ])
      .optional(),
  }),

  // serve → worker: hook approval state participates in PTY semantic inference.
  z.object({
    type: z.literal("pty_approval_context"),
    sessionId: z.string(),
    waiting: z.boolean(),
  }),

  // 输入，从服务端转发到客户端的 PTY stdin（手机远程输入注入）
  z.object({
    type: z.literal("pty_input"),
    sessionId: z.string(),
    data: z.string(),
    traceId: z.string().optional(),
  }),

  // serve → terminal：Web 端移除本地终端会话时，只断开远程视图，不杀本地 CLI。
  z.object({
    type: z.literal("pty_detach"),
    sessionId: z.string(),
  }),

  // serve → terminal worker：终止 Web 创建的纯终端进程。
  z.object({
    type: z.literal("pty_terminate"),
    sessionId: z.string(),
  }),

  // 错误响应
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),

  // terminal → serve：终端标题变化，由 xterm onTitleChange 触发
  z.object({
    type: z.literal("pty_title_change"),
    sessionId: z.string(),
    title: z.string(),
  }),

  // terminal → serve：shell 通过 OSC 7 报告的当前工作目录
  z.object({
    type: z.literal("pty_cwd_change"),
    sessionId: z.string(),
    cwd: z.string().min(1),
  }),

  // terminal → serve：local runtime 观察到的 PTY 语义事件。
  z.object({
    type: z.literal("pty_semantic_event"),
    sessionId: z.string(),
    state: z.enum(ptySemanticStateValues),
    seq: z.number().int().nonnegative(),
    title: z.string().optional(),
    tool: z.string().optional(),
  }),

  // terminal → serve：终端尺寸变化
  z.object({
    type: z.literal("pty_resize"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    // Shares the monotonic render-event sequence used by binary PTY frames and snapshots.
    outputSeq: z.number().int().nonnegative(),
  }),

  // serve → terminal worker：Web owns pure terminal geometry, so resize requests flow down.
  z.object({
    type: z.literal("pty_resize_request"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),

  // serve → terminal：请求 HeadlessTerminal serialize() 快照
  z.object({
    type: z.literal("pty_subscribe"),
    sessionId: z.string(),
    requestId: z.string(),
  }),

  // terminal → serve：serialize() 结果
  z.object({
    type: z.literal("pty_snapshot"),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    data: z.string(),
    outputSeq: z.number().int().nonnegative(),
    requestId: z.string(),
  }),

  // serve → terminal：relay 连接状态变更，供终端给用户显示 remote viewing 是否通畅
  z.object({
    type: z.literal("bridge_status"),
    connected: z.boolean(),
  }),
]);

// serve 与 session-worker 之间的通信协议
export const WorkerMessageSchema = z.discriminatedUnion("type", [
  // worker → serve: every socket connection begins with this protocol and process identity.
  // Readiness is reported separately because provider bootstrap can fail after IPC negotiation.
  // Hello extensions are informational; the required version and identity remain authoritative.
  z.object({
    type: z.literal("worker_protocol_hello"),
    protocolVersion: z.literal(WORKER_IPC_PROTOCOL_VERSION),
    sessionId: z.string().min(1),
    provider: z.enum(providerValues),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),

  // serve → worker: the worker also rejects a daemon from another IPC generation.
  z.object({
    type: z.literal("serve_protocol_hello"),
    protocolVersion: z.literal(WORKER_IPC_PROTOCOL_VERSION),
    sessionId: z.string().min(1),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),

  // serve → worker: 发送用户输入给 claude
  z.object({
    type: z.literal("worker_input"),
    content: z.string(),
  }),

  // serve → worker: 停止 claude 进程（终止整个 JSON 会话）
  z.object({
    type: z.literal("worker_stop"),
  }),

  // serve → worker: 只中断当前 provider turn，worker 进程保持可复用。
  z.object({
    type: z.literal("worker_interrupt"),
  }),

  // serve → worker: 工具审批响应
  z.object({
    type: z.literal("worker_approval_response"),
    requestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
    remember: z.boolean().optional(),
    optionId: z.string().optional(),
  }),

  // worker → serve: provider 输出事件（带序列号）
  z.object({
    type: z.literal("worker_event"),
    seq: z.number(),
    event: z.record(z.string(), z.unknown()),
  }),

  // worker → serve: provider 进程退出
  z.object({
    type: z.literal("worker_exit"),
    code: z.number(),
    errorTail: z.string().max(2048).optional(),
  }),

  // worker → serve: 当前 turn 已中断，JSON 会话仍可继续接收后续输入。
  z.object({
    type: z.literal("worker_interrupted"),
  }),

  // worker → serve: provider 真正开始执行一个排队中的 turn（区别于仅接收输入）。
  z.object({
    type: z.literal("worker_turn_started"),
  }),

  // worker → serve: 工具审批请求
  z.object({
    type: z.literal("worker_approval_request"),
    requestId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    options: z.array(ApprovalOptionSchema).optional(),
  }),

  // worker → serve: worker 就绪。Claude 在进程启动后发送；Codex/Kimi 分别在
  // app-server/ACP initialize + native session start|resume 完成后发送。
  z.object({
    type: z.literal("worker_ready"),
    pid: z.number(),
    nativeSession: z
      .object({
        provider: z.enum(providerValues),
        sessionId: z.string(),
      })
      .optional(),
  }),

  // Provider 在 worker_ready 之前失败时保留一小段脱敏后的诊断；可识别错误同时携带
  // 结构化 code，serve 不再只能把它降级成笼统的 WORKER_START_FAILED。
  z.object({
    type: z.literal("worker_startup_error"),
    provider: z.enum(providerValues),
    message: z.string().max(2048),
    errorCode: z.literal(ControlErrorCode.SESSION_ALREADY_ACTIVE).optional(),
    nativeSessionId: z.string().optional(),
  }),

  // worker → serve: provider 原生会话 ID。
  z.object({
    type: z.literal("worker_native_session_id"),
    provider: z.enum(providerValues),
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

// 单条 NDJSON 的解析/schema 错误必须交给连接所有者明确处理；reader 不替调用方决定
// 是记录并继续，还是关闭传输。
export function createWorkerReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: WorkerMessage) => void,
  onProtocolError: (err: Error, line: string) => void,
): void {
  const lineBuffer = new LineBuffer();
  lineBuffer.on("data", (line: Buffer | string) => {
    const str = typeof line === "string" ? line : line.toString();
    if (str.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(str);
    } catch (err) {
      onProtocolError(new Error("Worker message parse error", { cause: err }), str);
      return;
    }
    const result = WorkerMessageSchema.safeParse(raw);
    if (!result.success) {
      onProtocolError(new Error(`Worker message validation failed: ${result.error.message}`), str);
      return;
    }
    onMessage(result.data);
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
// 同 createWorkerReader：解析/schema 错误必须由调用方显式处理。
export function createIpcReader(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: IpcMessage) => void,
  onBinaryFrame: ((sessionId: string, data: Buffer, outputSeq: number) => void) | undefined,
  onProtocolError: (err: Error, line: string) => void,
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
          // 向调用方交付独立 Buffer，避免后续 buf reslice 改变已交付的数据。
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

        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (err) {
          onProtocolError(new Error("IPC message parse error", { cause: err }), line);
          continue;
        }
        const result = IpcMessageSchema.safeParse(raw);
        if (!result.success) {
          onProtocolError(
            new Error(`IPC message validation failed: ${result.error.message}`),
            line,
          );
          continue;
        }
        // Application callback failures are not protocol parse failures. Let them reach the
        // owning connection handler instead of silently turning a valid request into a timeout.
        onMessage(result.data);
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
