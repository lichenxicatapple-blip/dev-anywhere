import { connect, type Socket } from "node:net";
import { unlinkSync, existsSync, readdirSync } from "node:fs";
import { buildMessage } from "@cc-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import {
  ContentBlockDeltaSchema,
  IGNORED_EVENT_TYPES,
  KnownContentBlockSchema,
  StreamJsonEventSchema,
} from "../common/stream-json-schema.js";
import { DATA_DIR, sessionPaths } from "../common/paths.js";
import { spawnScript } from "../common/env.js";
import { SeqCounter } from "../common/seq-counter.js";
import { createWorkerReader, serializeWorkerMsg, type WorkerMessage } from "../ipc/ipc-protocol.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConnection } from "./relay-connection.js";
import type { ToolApprovalManager } from "./tool-approval-manager.js";
import type { JsonObserver } from "./json-observer.js";

interface WorkerRegistryDeps {
  sessionManager: SessionManager;
  toolApprovalManager: ToolApprovalManager;
  relayConnection: RelayConnection;
  // JSON 观察通道状态机；forwardEvent / forwardApprovalRequest 据此推状态变迁
  jsonObserver: JsonObserver;
}

interface SpawnOptions {
  cwd?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  // 开启后 worker spawn claude 带 --include-partial-messages，forwardEvent 处理 stream_event delta；
  // aggregated assistant 的 text/thinking 会被跳过避免和 delta 重复
  streamDelta?: boolean;
}

// 管理 session → worker socket 的映射，封装全部 worker IO：
// - spawn / connect / reconnectAll / destroyAll 生命周期入口
// - send(sessionId, msg) 统一出口
// - worker_event 路由、worker_approval_request 转发、worker_exit 清理都在内部闭环
export class WorkerRegistry {
  private sockets = new Map<string, Socket>();
  // 记录哪些 session 是 spawn 时带 --stream-delta 的；forwardEvent 据此决定是否跳过 aggregated 去重
  private streamDeltaSessions = new Set<string>();

  constructor(private deps: WorkerRegistryDeps) {
    // relay queue 溢出时，被 drop 的 envelope 不会到达 client；若是 tool_use_request，
    // 主动清 pending 审批并回 worker env-failure deny，避免 worker 永挂、toolApprovalManager 泄漏。
    deps.relayConnection.on("envelope_dropped", (raw: string) => this.onEnvelopeDropped(raw));
  }

  private onEnvelopeDropped(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: unknown }).type !== "tool_use_request"
    ) {
      return;
    }
    const envelope = parsed as {
      sessionId?: unknown;
      payload?: { toolId?: unknown };
    };
    const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : null;
    const requestId =
      envelope.payload && typeof envelope.payload.toolId === "string"
        ? envelope.payload.toolId
        : null;
    if (!sessionId || !requestId) return;
    if (!this.deps.toolApprovalManager.take(requestId)) return;

    serviceLogger.warn(
      { sessionId, requestId },
      "Tool approval request lost to relay queue overflow, denying worker",
    );
    this.send(sessionId, {
      type: "worker_approval_response",
      requestId,
      behavior: "deny",
      message: "Approval request was dropped due to relay queue overflow.",
    });
  }

  spawn(sessionId: string, options?: SpawnOptions): number {
    const paths = sessionPaths(sessionId);
    const args: string[] = [sessionId, paths.workerSock];
    if (options?.cwd) args.push("--cwd", options.cwd);
    if (options?.resumeSessionId) args.push("--resume", options.resumeSessionId);
    // 远程场景默认 default，每个工具都需审批，覆盖用户全局 claude settings 的 defaultMode
    args.push("--permission-mode", options?.permissionMode ?? "default");
    if (options?.streamDelta) {
      args.push("--stream-delta");
      this.streamDeltaSessions.add(sessionId);
    }
    args.push("--");

    const child = spawnScript(new URL("./session-worker", import.meta.url), args, {
      logger: serviceLogger,
    });
    const workerPid = child.pid!;
    serviceLogger.info(
      { sessionId, workerPid, cwd: options?.cwd, resume: options?.resumeSessionId },
      "Worker process spawned",
    );
    return workerPid;
  }

  connect(sessionId: string, sockPath: string): Promise<Socket | null> {
    return new Promise((resolve) => {
      const sock = connect(sockPath);
      sock.on("connect", () => {
        this.sockets.set(sessionId, sock);
        createWorkerReader(sock, (msg) => this.handleWorkerMessage(sessionId, msg));
        sock.on("close", () => this.onDisconnect(sessionId));
        sock.on("error", () => this.onDisconnect(sessionId));
        resolve(sock);
      });
      sock.on("error", () => resolve(null));
    });
  }

  // 枚举 DATA_DIR 下所有 session 目录，尝试连接存活的 worker.sock；失败则清理 stale socket。
  async reconnectAll(): Promise<void> {
    if (!existsSync(DATA_DIR)) return;

    const dirs = readdirSync(DATA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

    for (const dir of dirs) {
      const sessionId = dir.name;
      const paths = sessionPaths(sessionId);
      if (!existsSync(paths.workerSock)) continue;

      const sock = await this.connect(sessionId, paths.workerSock);
      if (sock) {
        if (!this.deps.sessionManager.getSession(sessionId)) {
          // 两边数据源不一致：DATA_DIR 下的 worker.sock 能连通说明 worker 进程还在跑，
          // 但 SessionManager 的内存 Map（持久化已在 load 时清过）里没这条 session。
          // 成因：sessions.json 被删 / 写盘失败 / 记录丢失而 worker 没跟着退。这类孤儿 worker 清掉。
          serviceLogger.warn(
            { sessionId },
            "Orphaned worker found without session data, terminating",
          );
          sock.end();
          this.sockets.delete(sessionId);
          continue;
        }
        serviceLogger.info({ sessionId }, "Reconnected to existing worker");
      } else {
        try {
          unlinkSync(paths.workerSock);
        } catch {
          // socket 文件可能已被删除
        }
        serviceLogger.info({ sessionId }, "Cleaned up stale worker socket");
      }
    }
  }

  has(sessionId: string): boolean {
    return this.sockets.has(sessionId);
  }

  delete(sessionId: string): void {
    this.sockets.delete(sessionId);
    this.streamDeltaSessions.delete(sessionId);
  }

  // 向指定 session 的 worker 写 WorkerMessage；socket 缺失或不可写返回 false 由 caller 决定日志。
  send(sessionId: string, msg: WorkerMessage): boolean {
    const sock = this.sockets.get(sessionId);
    if (!sock?.writable) return false;
    sock.write(serializeWorkerMsg(msg));
    return true;
  }

  destroyAll(): void {
    for (const [, ws] of this.sockets) {
      ws.destroy();
    }
    this.sockets.clear();
  }

  private handleWorkerMessage(sessionId: string, msg: WorkerMessage): void {
    switch (msg.type) {
      case "worker_ready":
        serviceLogger.info({ sessionId, pid: msg.pid }, "Worker ready");
        break;

      case "worker_event":
        try {
          this.forwardEvent(sessionId, msg.seq, msg.event);
        } catch (err) {
          serviceLogger.debug(
            { sessionId, error: String(err) },
            "Failed to forward event to relay",
          );
        }
        serviceLogger.debug({ sessionId, eventType: msg.event.type }, "JSON session event");
        break;

      case "worker_exit":
        this.deps.sessionManager.terminateSession(sessionId);
        this.sockets.delete(sessionId);
        this.streamDeltaSessions.delete(sessionId);
        serviceLogger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
        break;

      case "worker_approval_request":
        this.forwardApprovalRequest(sessionId, msg);
        break;

      case "worker_claude_session_id":
        this.deps.sessionManager.setClaudeSessionId(sessionId, msg.sessionId);
        serviceLogger.info(
          { sessionId, claudeSessionId: msg.sessionId },
          "Claude session ID captured",
        );
        break;
    }
  }

  // worker 连接断开或异常时的统一清理入口。仅记录一份，不再区分 close vs error 语义。
  private onDisconnect(sessionId: string): void {
    this.sockets.delete(sessionId);
    this.deps.toolApprovalManager.cleanupSession(sessionId, "Worker disconnected");
  }

  // 对齐 Claude CLI stream-json 输出，按 type 分发：
  //   stream_event.content_block_delta → 增量 text/thinking envelope（仅 streamDelta 会话产生）
  //   assistant.content[].text      → assistant_message envelope（streamDelta 下跳过，避免重复）
  //   assistant.content[].thinking  → thinking envelope（streamDelta 下跳过）
  //   assistant.content[].tool_use  → assistant_tool_use envelope
  //   user.content[].tool_result    → tool_result envelope
  //   result                        → turn_result control + 会话状态回 IDLE
  //   system/rate_limit_event/其他  → 静默忽略
  // schema 未识别的 event/block 以 warn 暴露，作为 Claude CLI 协议变化的 runtime canary。
  private forwardEvent(sessionId: string, seq: number, event: Record<string, unknown>): void {
    const relay = this.deps.relayConnection;
    const parsed = StreamJsonEventSchema.safeParse(event);
    if (!parsed.success) {
      const rawType = typeof event.type === "string" ? event.type : "<missing>";
      if (IGNORED_EVENT_TYPES.has(rawType)) {
        serviceLogger.debug({ sessionId, type: rawType }, "Dropped ignored stream-json event");
        return;
      }
      serviceLogger.warn(
        { sessionId, type: rawType, issues: parsed.error.issues.slice(0, 3) },
        "Unknown stream-json event type; Claude CLI schema may have changed",
      );
      return;
    }
    const ev = parsed.data;
    const isStreamDeltaSession = this.streamDeltaSessions.has(sessionId);

    if (ev.type === "stream_event") {
      const delta = ContentBlockDeltaSchema.safeParse(ev.event);
      if (!delta.success) return; // 非 content_block_delta 的内层事件（message_start 等）忽略
      const d = delta.data.delta;
      if (d.type === "text_delta" && d.text) {
        relay.sendEnvelope(
          buildMessage(
            "assistant_message",
            sessionId,
            seq,
            { text: d.text, isPartial: true },
            "proxy",
          ),
        );
      } else if (d.type === "thinking_delta" && d.thinking) {
        relay.sendEnvelope(buildMessage("thinking", sessionId, seq, { text: d.thinking }, "proxy"));
      }
      return;
    }

    if (ev.type === "assistant") {
      for (const raw of ev.message.content) {
        const blockParse = KnownContentBlockSchema.safeParse(raw);
        if (!blockParse.success) {
          const rawType =
            raw && typeof raw === "object"
              ? ((raw as Record<string, unknown>).type as string | undefined)
              : undefined;
          serviceLogger.warn(
            { sessionId, seq, blockType: rawType ?? "<missing>" },
            "Unknown assistant content block; Claude CLI schema may have changed",
          );
          continue;
        }
        const block = blockParse.data;
        if (block.type === "text") {
          // streamDelta 下增量已经发过了，aggregated 全文跳过避免重复
          if (!isStreamDeltaSession && block.text) {
            relay.sendEnvelope(
              buildMessage(
                "assistant_message",
                sessionId,
                seq,
                { text: block.text, isPartial: true },
                "proxy",
              ),
            );
          }
        } else if (block.type === "thinking") {
          // Opus extended thinking 明文被 Anthropic 服务端 redact 时 block.thinking 为空字符串，
          // 不转发；session WORKING 状态已经覆盖"Claude 在思考"信号，redacted envelope 无新信息
          if (!isStreamDeltaSession && block.thinking) {
            relay.sendEnvelope(
              buildMessage("thinking", sessionId, seq, { text: block.thinking }, "proxy"),
            );
          }
        } else if (block.type === "tool_use") {
          relay.sendEnvelope(
            buildMessage(
              "assistant_tool_use",
              sessionId,
              seq,
              { toolName: block.name, toolId: block.id, parameters: block.input },
              "proxy",
            ),
          );
        }
      }
      return;
    }

    if (ev.type === "user") {
      for (const raw of ev.message.content) {
        const blockParse = KnownContentBlockSchema.safeParse(raw);
        if (!blockParse.success) continue;
        const block = blockParse.data;
        if (block.type !== "tool_result") continue;
        relay.sendEnvelope(
          buildMessage(
            "tool_result",
            sessionId,
            seq,
            { toolId: block.tool_use_id, result: block.content, isError: block.is_error ?? false },
            "proxy",
          ),
        );
      }
      return;
    }

    if (ev.type === "result") {
      relay.sendRaw(
        JSON.stringify({
          type: "turn_result",
          sessionId,
          success: ev.subtype === "success",
          isError: ev.is_error ?? false,
        }),
      );
      this.deps.jsonObserver.onTurnResult(sessionId);
    }
  }

  private forwardApprovalRequest(
    sessionId: string,
    msg: Extract<WorkerMessage, { type: "worker_approval_request" }>,
  ): void {
    serviceLogger.info(
      { sessionId, toolName: msg.toolName, requestId: msg.requestId },
      "Tool approval forwarding to relay",
    );
    this.deps.jsonObserver.onApprovalRequested(sessionId);
    try {
      const seqCounter = new SeqCounter(sessionId);
      const approvalSeq = seqCounter.next();
      const envelope = buildMessage(
        "tool_use_request",
        sessionId,
        approvalSeq,
        {
          toolName: msg.toolName,
          toolId: msg.requestId,
          parameters: msg.input,
        },
        "proxy",
      );
      this.deps.relayConnection.sendEnvelope(envelope);
      this.deps.toolApprovalManager.register(msg.requestId, {
        sessionId,
        toolName: msg.toolName,
        input: msg.input,
      });
    } catch (err) {
      // envelope 构造失败回 deny，避免 worker 无限等待。
      serviceLogger.warn(
        { sessionId, error: String(err) },
        "Failed to forward tool approval to relay, denying",
      );
      this.send(sessionId, {
        type: "worker_approval_response",
        requestId: msg.requestId,
        behavior: "deny",
        message: "Failed to forward approval request to relay.",
      });
    }
  }
}
