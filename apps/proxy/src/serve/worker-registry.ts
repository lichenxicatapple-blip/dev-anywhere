import { connect, type Socket } from "node:net";
import { unlinkSync, existsSync, readdirSync } from "node:fs";
import { SessionState, buildMessage } from "@cc-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { DATA_DIR, sessionPaths } from "../common/paths.js";
import { spawnScript } from "../common/env.js";
import { SeqCounter } from "../common/seq-counter.js";
import { createWorkerReader, serializeWorkerMsg } from "../ipc/ipc-protocol.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConnection } from "./relay-connection.js";
import type { ToolApprovalManager } from "./tool-approval-manager.js";

interface WorkerRegistryDeps {
  sessionManager: SessionManager;
  toolApprovalManager: ToolApprovalManager;
  relayConnection: RelayConnection | null;
  // session 状态迁移需要通知客户端，同时 updateState 鉴于非法转换的守卫
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
}

interface SpawnOptions {
  cwd?: string;
  resumeSessionId?: string;
  permissionMode?: string;
}

// 管理 session → worker socket 的映射，并负责 spawn/connect/reconnect 三个生命周期入口。
// worker_event 路由、worker_approval_request 转发、worker_exit 清理都在内部闭环，
// 让 serve.ts 侧只通过 getSocket 拿到 write 能力。
export class WorkerRegistry {
  private sockets = new Map<string, Socket>();

  constructor(private deps: WorkerRegistryDeps) {}

  spawn(sessionId: string, options?: SpawnOptions): number {
    const paths = sessionPaths(sessionId);
    const args: string[] = [sessionId, paths.workerSock];
    if (options?.cwd) args.push("--cwd", options.cwd);
    if (options?.resumeSessionId) args.push("--resume", options.resumeSessionId);
    // 远程场景默认 default，每个工具都需审批，覆盖用户全局 claude settings 的 defaultMode
    args.push("--permission-mode", options?.permissionMode ?? "default");
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
        createWorkerReader(sock, (msg) => this.handleWorkerMessage(sessionId, sock, msg));
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
          // SessionManager 加载时已经清理了不匹配的持久化，还能连上说明 worker 孤儿
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

  getSocket(sessionId: string): Socket | undefined {
    return this.sockets.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sockets.has(sessionId);
  }

  delete(sessionId: string): void {
    this.sockets.delete(sessionId);
  }

  destroyAll(): void {
    for (const [, ws] of this.sockets) {
      ws.destroy();
    }
    this.sockets.clear();
  }

  private handleWorkerMessage(
    sessionId: string,
    sock: Socket,
    msg: import("../ipc/ipc-protocol.js").WorkerMessage,
  ): void {
    switch (msg.type) {
      case "worker_ready":
        serviceLogger.info({ sessionId, pid: msg.pid }, "Worker ready");
        break;

      case "worker_event":
        // WORKING 状态由 user_input 入口负责推；这里只转发事件本身到 relay，
        // result 事件交由 forwardEvent 在 turn 结束后把 session 推回 IDLE。
        if (this.deps.relayConnection) {
          try {
            this.forwardEvent(sessionId, msg.seq, msg.event);
          } catch (err) {
            serviceLogger.debug(
              { sessionId, error: String(err) },
              "Failed to forward event to relay",
            );
          }
        }
        serviceLogger.debug({ sessionId, eventType: msg.event.type }, "JSON session event");
        break;

      case "worker_replay_done":
        serviceLogger.info(
          { sessionId, replayedCount: msg.replayedCount },
          "Worker event replay complete",
        );
        break;

      case "worker_exit":
        this.deps.sessionManager.terminateSession(sessionId);
        this.sockets.delete(sessionId);
        serviceLogger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
        break;

      case "worker_approval_request":
        this.forwardApprovalRequest(sessionId, sock, msg);
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

  // 对齐 Claude CLI stream-json 输出：
  //   assistant.content[].text → assistant_message envelope
  //   assistant.content[].thinking → thinking envelope
  //   result → turn_result control + 会话状态回 IDLE
  //   system/user/其他：忽略（无 UI 影响）
  private forwardEvent(sessionId: string, seq: number, event: Record<string, unknown>): void {
    const relay = this.deps.relayConnection;
    if (!relay) return;

    const type = event.type;
    if (type === "assistant") {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const content = message?.content ?? [];
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => (c.text as string | undefined) ?? "")
        .join("");
      if (text) {
        relay.sendEnvelope(
          buildMessage("assistant_message", sessionId, seq, { text, isPartial: true }, "proxy"),
        );
      }
      const thinkingBlock = content.find((c) => c.type === "thinking");
      if (thinkingBlock) {
        const thinkingText = (thinkingBlock.thinking as string | undefined) ?? "";
        if (thinkingText) {
          relay.sendEnvelope(
            buildMessage("thinking", sessionId, seq, { text: thinkingText }, "proxy"),
          );
        }
      }
      return;
    }
    if (type === "result") {
      relay.sendRaw(
        JSON.stringify({
          type: "turn_result",
          sessionId,
          success: event.subtype === "success",
          isError: Boolean(event.is_error),
        }),
      );
      this.deps.changeSessionState(sessionId, SessionState.IDLE);
    }
  }

  private forwardApprovalRequest(
    sessionId: string,
    sock: Socket,
    msg: Extract<
      import("../ipc/ipc-protocol.js").WorkerMessage,
      { type: "worker_approval_request" }
    >,
  ): void {
    const relay = this.deps.relayConnection;
    if (!relay) {
      // 无 relay = 无 remote 审批者，直接 deny 以免 worker 卡住。
      serviceLogger.info(
        { sessionId, toolName: msg.toolName },
        "Tool approval denied (no relay connection)",
      );
      sock.write(
        serializeWorkerMsg({
          type: "worker_approval_response",
          requestId: msg.requestId,
          behavior: "deny",
          message: "No relay connection available for remote approval.",
        }),
      );
      return;
    }

    serviceLogger.info(
      { sessionId, toolName: msg.toolName, requestId: msg.requestId },
      "Tool approval forwarding to relay",
    );
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
      relay.sendEnvelope(envelope);
      this.deps.toolApprovalManager.register(msg.requestId, {
        sessionId,
        toolName: msg.toolName,
        input: msg.input,
        workerSocket: sock,
      });
    } catch (err) {
      // envelope 构造失败回 deny，避免 worker 无限等待。
      serviceLogger.warn(
        { sessionId, error: String(err) },
        "Failed to forward tool approval to relay, denying",
      );
      sock.write(
        serializeWorkerMsg({
          type: "worker_approval_response",
          requestId: msg.requestId,
          behavior: "deny",
          message: "Failed to forward approval request to relay.",
        }),
      );
    }
  }
}
