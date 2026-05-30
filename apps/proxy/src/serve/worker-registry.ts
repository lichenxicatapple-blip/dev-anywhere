import { connect, type Socket } from "node:net";
import { unlinkSync, existsSync, readdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { buildMessage, serializeControl, SessionState } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import {
  IGNORED_EVENT_TYPES,
  StreamJsonEventSchema,
  type StreamJsonEvent,
} from "../common/stream-json-schema.js";
import { DATA_DIR, sessionPaths } from "../common/paths.js";
import { spawnScript } from "../common/env.js";
import { getSeqCounterFor } from "../common/seq-counter.js";
import { createWorkerReader, serializeWorkerMsg, type WorkerMessage } from "../ipc/ipc-protocol.js";
import { mapClaudeStreamEvent } from "./claude-stream-event-mapper.js";
import { mapCodexAppServerEvent } from "./codex-app-server-event-mapper.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConnection } from "./relay-connection.js";
import type { JsonObserver } from "./json-observer.js";
import type { ProviderHookContext, ProviderId } from "../providers/index.js";
import type { PermissionBroker, PermissionDecision } from "./permission-broker.js";

interface CompactCommandOutcome {
  success: boolean;
  message: string;
}

interface WorkerRegistryDeps {
  sessionManager: SessionManager;
  permissionBroker: PermissionBroker;
  relayConnection: RelayConnection;
  // JSON 观察通道状态机；forwardEvent / forwardApprovalRequest 据此推状态变迁
  jsonObserver: JsonObserver;
  touchSessionActivity?: (sessionId: string) => boolean;
  getProviderEnv: () => NodeJS.ProcessEnv;
  nextSeq?: (sessionId: string) => number;
}

interface SpawnOptions {
  cwd?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  provider?: ProviderId;
  // 开启后 worker spawn claude 带 --include-partial-messages，forwardEvent 处理 stream_event delta；
  // aggregated assistant 的 text/thinking 会被跳过避免和 delta 重复
  streamDelta?: boolean;
  hook?: ProviderHookContext;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function normalizeLocalCommandText(content: string): string {
  return content
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/<\/?local-command-(?:stdout|stderr)>/g, "")
    .trim();
}

function parseCompactCommandOutcome(content: string): CompactCommandOutcome | null {
  const normalized = normalizeLocalCommandText(content);
  if (!normalized) return null;

  if (content.includes("<local-command-stderr>")) {
    let detail = normalized
      .replace(/^Error:\s*/i, "")
      .replace(/^Error during compaction:\s*/i, "")
      .trim();
    if (/No messages to compact/i.test(detail)) {
      return { success: true, message: "没有可压缩的上下文。" };
    }
    if (!detail) detail = "请稍后重试。";
    return { success: false, message: `上下文压缩失败：${detail}` };
  }

  if (content.includes("<local-command-stdout>") || /\bCompacted\b/i.test(normalized)) {
    return { success: true, message: "上下文压缩完成。" };
  }

  return null;
}

// 管理 session → worker socket 的映射，封装全部 worker IO：
// - spawn / connect / reconnectAll / destroyAll 生命周期入口
// - send(sessionId, msg) 统一出口
// - worker_event 路由、worker_approval_request 转发、worker_exit 清理都在内部闭环
export class WorkerRegistry {
  private sockets = new Map<string, Socket>();
  private children = new Map<string, ChildProcess>();
  private readySessions = new Set<string>();
  private readyWaiters = new Map<string, Set<ReadyWaiter>>();
  // 记录哪些 session 是 spawn 时带 --stream-delta 的；forwardEvent 据此决定是否跳过 aggregated 去重
  private streamDeltaSessions = new Set<string>();

  constructor(private deps: WorkerRegistryDeps) {
    // relay queue 溢出时，被 drop 的 envelope 不会到达 client；若是 tool_use_request，
    // 主动清 pending 审批并回 worker env-failure deny，避免 worker 永挂、permission broker 泄漏。
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
    if (
      !this.deps.permissionBroker.resolve(requestId, {
        behavior: "deny",
        message: "Approval request was dropped due to relay queue overflow.",
      })
    ) {
      return;
    }

    serviceLogger.warn(
      { sessionId, requestId },
      "Tool approval request lost to relay queue overflow, denying worker",
    );
  }

  waitForReady(sessionId: string, timeoutMs = 15_000): Promise<void> {
    if (this.readySessions.has(sessionId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.readyWaiters.get(sessionId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.readyWaiters.delete(sessionId);
        }
        reject(new Error(`Worker did not report ready within ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      const waiter: ReadyWaiter = { resolve, reject, timeout };
      const waiters = this.readyWaiters.get(sessionId) ?? new Set<ReadyWaiter>();
      waiters.add(waiter);
      this.readyWaiters.set(sessionId, waiters);
    });
  }

  spawn(sessionId: string, options?: SpawnOptions): number {
    const paths = sessionPaths(sessionId);
    const args: string[] = [sessionId, paths.workerSock];
    args.push("--provider", options?.provider ?? "claude");
    if (options?.cwd) args.push("--cwd", options.cwd);
    if (options?.resumeSessionId) args.push("--resume", options.resumeSessionId);
    // 远程场景默认 default，每个工具都需审批，覆盖用户全局 claude settings 的 defaultMode
    args.push("--permission-mode", options?.permissionMode ?? "default");
    if (options?.streamDelta) {
      args.push("--stream-delta");
      this.streamDeltaSessions.add(sessionId);
    }
    if (options?.hook) {
      args.push(
        "--hook-provider",
        options.hook.provider,
        "--hook-url",
        options.hook.hookUrl,
        "--hook-marker",
        options.hook.marker,
      );
    }
    args.push("--");

    const providerEnv = this.deps.getProviderEnv();
    const child = spawnScript("session-worker", args, {
      logger: serviceLogger,
      env: options?.hook
        ? { ...providerEnv, DEV_ANYWHERE_HOOK_TOKEN: options.hook.token }
        : providerEnv,
    });
    const workerPid = child.pid!;
    this.children.set(sessionId, child);
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
        createWorkerReader(
          sock,
          (msg) => this.handleWorkerMessage(sessionId, msg),
          (err, line) => {
            // 单条 worker NDJSON 行 schema 校验失败：warn 而非断连。Claude/Codex CLI 增量
            // 加新事件类型时不该把整个 session 推进 ERROR；连接保持开放，下一条仍继续解析。
            serviceLogger.warn(
              { sessionId, err: err.message, lineLen: line.length },
              "Worker IPC message dropped (parse/schema error)",
            );
          },
        );
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
          // worker.sock 可连通但 SessionManager 无该 session 记录
          // （sessions.json 写盘失败或文件丢失，但 worker 仍存活），属于孤儿 worker，直接终止。
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
    this.children.delete(sessionId);
    this.sockets.delete(sessionId);
    this.readySessions.delete(sessionId);
    this.streamDeltaSessions.delete(sessionId);
    this.rejectReadyWaiters(
      new Error(`Worker session deleted before ready: ${sessionId}`),
      sessionId,
    );
  }

  terminateProcess(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const child = this.children.get(sessionId);
    const sock = this.sockets.get(sessionId);
    sock?.destroy();
    this.sockets.delete(sessionId);
    this.readySessions.delete(sessionId);
    this.streamDeltaSessions.delete(sessionId);
    this.children.delete(sessionId);
    this.rejectReadyWaiters(
      new Error(`Worker process terminated before ready: ${sessionId}`),
      sessionId,
    );
    if (!child || child.killed) return false;
    return child.kill(signal);
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
    this.readySessions.clear();
    this.rejectReadyWaiters(new Error("Worker registry destroyed"));
  }

  private handleWorkerMessage(sessionId: string, msg: WorkerMessage): void {
    switch (msg.type) {
      case "worker_ready":
        this.readySessions.add(sessionId);
        this.resolveReadyWaiters(sessionId);
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
        this.delete(sessionId);
        serviceLogger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
        break;

      case "worker_interrupted":
        this.deps.permissionBroker.cleanupSession(sessionId, "Turn interrupted");
        this.deps.relayConnection.sendRaw(
          serializeControl({
            type: "pending_approvals_push",
            sessionId,
            approvals: [],
          }),
        );
        this.deps.relayConnection.sendRaw(
          serializeControl({
            type: "turn_result",
            sessionId,
            success: false,
            isError: true,
          }),
        );
        this.deps.jsonObserver.onTurnResult(sessionId);
        serviceLogger.info({ sessionId }, "JSON turn interrupted");
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

      case "worker_native_session_id":
        if (msg.provider === "claude") {
          this.deps.sessionManager.setClaudeSessionId(sessionId, msg.sessionId);
        } else {
          this.deps.sessionManager.setHistorySessionId(sessionId, msg.sessionId);
        }
        serviceLogger.info(
          { sessionId, provider: msg.provider, nativeSessionId: msg.sessionId },
          "Native JSON session ID captured",
        );
        break;
    }
  }

  // worker 连接断开或异常时的统一清理入口。仅记录一份，不再区分 close vs error 语义。
  private onDisconnect(sessionId: string): void {
    this.sockets.delete(sessionId);
    this.readySessions.delete(sessionId);
    this.rejectReadyWaiters(new Error(`Worker disconnected before ready: ${sessionId}`), sessionId);
    this.deps.permissionBroker.cleanupSession(sessionId, "Worker disconnected");
    // worker_exit 消息走 handleWorkerMessage，那条路径已经 terminateSession 把 session 从 manager
    // 中删掉——onDisconnect 紧随其后到达时 getSession 返回 undefined，不触发 ERROR 转换。
    // 只有"未经 worker_exit 即断连"（进程崩溃 / 内核 OOM kill / IPC socket 损坏）才会进入这里：
    // session 仍然在 manager 中，必须立即把状态推到 ERROR，否则 UI 看到的状态会停留在
    // WORKING / WAITING_APPROVAL 直到 reaper 60s 周期触发，期间用户既无法手动中止也无法重启。
    if (this.deps.sessionManager.getSession(sessionId)) {
      this.deps.jsonObserver.onChannelBroken(sessionId);
    }
  }

  private resolveReadyWaiters(sessionId: string): void {
    const waiters = this.readyWaiters.get(sessionId);
    if (!waiters) return;
    this.readyWaiters.delete(sessionId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(err: Error, sessionId?: string): void {
    const entries =
      sessionId === undefined
        ? [...this.readyWaiters.entries()]
        : ([[sessionId, this.readyWaiters.get(sessionId)]] as Array<
            [string, Set<ReadyWaiter> | undefined]
          >);
    for (const [sid, waiters] of entries) {
      if (!waiters) continue;
      this.readyWaiters.delete(sid);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(err);
      }
    }
  }

  // 对齐 Claude CLI stream-json 输出，按 type 分发：
  //   stream_event.content_block_delta → 增量 text/thinking envelope（仅 streamDelta 会话产生）
  //   assistant.content[].text      → assistant_message envelope（streamDelta 下跳过，避免重复）
  //   assistant.content[].thinking  → thinking envelope（streamDelta 下跳过）
  //   assistant.content[].tool_use  → assistant_tool_use envelope
  //   user.content[].tool_result    → tool_result envelope
  //   system/local_command          → /compact 成功/失败结果 + 会话状态回 IDLE
  //   result                        → turn_result control + 会话状态回 IDLE
  //   rate_limit_event/其他         → 静默忽略
  // schema 未识别的 event/block 以 warn 暴露，作为 Claude CLI 协议变化的 runtime canary。
  private forwardEvent(sessionId: string, seq: number, event: Record<string, unknown>): void {
    const relay = this.deps.relayConnection;
    if (event.type === "codex_app_server") {
      this.forwardCodexAppServerEvent(sessionId, seq, event);
      return;
    }
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
    this.deps.touchSessionActivity?.(sessionId);
    const isStreamDeltaSession = this.streamDeltaSessions.has(sessionId);

    if (ev.type === "system") {
      if (this.handleCompactSystemEvent(sessionId, seq, ev)) return;
      serviceLogger.debug(
        { sessionId, subtype: ev.subtype, status: ev.status },
        "Dropped ignored stream-json system event",
      );
      return;
    }

    if (ev.type === "user") {
      if (typeof ev.message.content === "string") {
        this.handleCompactLocalCommandOutput(sessionId, seq, ev.message.content);
        return;
      }
    }

    for (const mapped of mapClaudeStreamEvent(sessionId, seq, {
      event: ev,
      isStreamDeltaSession,
      isCompactingSession: this.isCompactingSession(sessionId),
    })) {
      if (mapped.kind === "envelope") {
        relay.sendEnvelope(mapped.envelope);
      } else if (mapped.kind === "control") {
        relay.sendRaw(mapped.raw);
        if (mapped.notifyTurnResult) this.deps.jsonObserver.onTurnResult(sessionId);
      } else {
        serviceLogger.warn(
          { sessionId, seq, blockType: mapped.blockType },
          "Unknown assistant content block; Claude CLI schema may have changed",
        );
      }
    }
  }

  private forwardCodexAppServerEvent(
    sessionId: string,
    seq: number,
    event: Record<string, unknown>,
  ): void {
    const relay = this.deps.relayConnection;
    this.deps.touchSessionActivity?.(sessionId);
    for (const mapped of mapCodexAppServerEvent(sessionId, seq, event)) {
      if (mapped.kind === "envelope") {
        relay.sendEnvelope(mapped.envelope);
      } else {
        relay.sendRaw(mapped.raw);
        if (mapped.notifyTurnResult) this.deps.jsonObserver.onTurnResult(sessionId);
      }
    }
  }

  private handleCompactSystemEvent(
    sessionId: string,
    seq: number,
    ev: Extract<StreamJsonEvent, { type: "system" }>,
  ): boolean {
    if (!this.isCompactingSession(sessionId)) return false;
    if (ev.subtype === "status" && ev.status === "compacting") return true;
    if (ev.subtype !== "local_command" || typeof ev.content !== "string") return false;
    return this.handleCompactLocalCommandOutput(sessionId, seq, ev.content);
  }

  private handleCompactLocalCommandOutput(
    sessionId: string,
    seq: number,
    content: string,
  ): boolean {
    if (!this.isCompactingSession(sessionId)) return false;
    const outcome = parseCompactCommandOutcome(content);
    if (!outcome) return false;
    this.deps.relayConnection.sendEnvelope(
      buildMessage(
        "assistant_message",
        sessionId,
        seq,
        { text: outcome.message, isPartial: true },
        "proxy",
      ),
    );
    this.sendCompactTurnResult(sessionId, outcome.success, outcome.message);
    serviceLogger[outcome.success ? "info" : "warn"](
      { sessionId, success: outcome.success },
      "Compact command completed",
    );
    return true;
  }

  private sendCompactTurnResult(sessionId: string, success: boolean, result?: string): void {
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "turn_result",
        sessionId,
        success,
        isError: !success,
        ...(result ? { result } : {}),
      }),
    );
    this.deps.jsonObserver.onTurnResult(sessionId);
  }

  private isCompactingSession(sessionId: string): boolean {
    return this.deps.sessionManager.getSession(sessionId)?.state === SessionState.COMPACTING;
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
      const approvalSeq = this.deps.nextSeq?.(sessionId) ?? getSeqCounterFor(sessionId).next();
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
      const session = this.deps.sessionManager.getSession(sessionId);
      const registered = this.deps.permissionBroker.registerWorkerRequest(
        {
          requestId: msg.requestId,
          provider: session?.provider ?? "claude",
          sessionId,
          toolName: msg.toolName,
          input: msg.input,
        },
        (decision: PermissionDecision) => {
          this.send(sessionId, {
            type: "worker_approval_response",
            requestId: msg.requestId,
            behavior: decision.behavior,
            ...(decision.message ? { message: decision.message } : {}),
          });
        },
      );
      if (!registered) return;
      this.deps.relayConnection.sendEnvelope(envelope);
    } catch (err) {
      const resolved = this.deps.permissionBroker.resolve(msg.requestId, {
        behavior: "deny",
        message: "Failed to forward approval request to relay.",
      });
      if (!resolved) {
        this.send(sessionId, {
          type: "worker_approval_response",
          requestId: msg.requestId,
          behavior: "deny",
          message: "Failed to forward approval request to relay.",
        });
      }
      // envelope 构造失败回 deny，避免 worker 无限等待。
      serviceLogger.warn(
        { sessionId, error: String(err) },
        "Failed to forward tool approval to relay, denying",
      );
    }
  }
}
