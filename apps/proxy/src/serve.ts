import { createServer, connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import {
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { SessionState, buildMessage } from "@cc-anywhere/shared";
import { serviceLogger } from "./common/logger.js";
import { SessionManager, type SessionInfo } from "./serve/session-manager.js";
import { RelayConnection } from "./serve/relay-connection.js";
import { SeqCounter } from "./common/seq-counter.js";
import { homedir } from "node:os";
import {
  SOCK_PATH,
  PID_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  DATA_DIR,
  sessionPaths,
  tildify,
} from "./common/paths.js";
import { spawnScript } from "./common/env.js";
import { loadConfig } from "./common/config.js";
import {
  createIpcReader,
  serializeIpc,
  createWorkerReader,
  serializeWorkerMsg,
  type IpcMessage,
  type WorkerMessage,
} from "./ipc/ipc-protocol.js";
import { nanoid } from "nanoid";
import {
  createControlMessageHandlers,
  type ControlMessageHandlers,
} from "./serve/handlers/control-messages.js";
import { readSessionMessages } from "./serve/session-history.js";

// ---------- 基础工具函数 ----------

function toSessionListPayload(s: SessionInfo) {
  return {
    sessionId: s.id,
    mode: s.mode,
    state: s.state,
    lastActive: s.updatedAt,
    ...(s.name !== undefined ? { name: s.name } : {}),
  };
}

// 推一条 session_status envelope 给 relay → client
// relay 对 envelope 透传（不走 PROXY_TO_CLIENT_TYPES 白名单）；payload 包含 lastActive 让列表相对时间跟着跳
function pushSessionStatus(
  relay: RelayConnection | null,
  sessionManager: SessionManager,
  sessionId: string,
): void {
  if (!relay) return;
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  try {
    const envelope = buildMessage(
      "session_status",
      session.id,
      Date.now(),
      { sessionId: session.id, state: session.state, lastActive: session.updatedAt },
      "proxy",
    );
    relay.sendEnvelope(envelope);
  } catch (err) {
    serviceLogger.debug({ sessionId, error: String(err) }, "Failed to push session_status");
  }
}

// 状态迁移 + 推 envelope 的一体化入口；same-state 或非法转移时静默 no-op，避免调用方遍地 try/catch
function changeSessionState(
  sessionManager: SessionManager,
  relay: RelayConnection | null,
  sessionId: string,
  next: SessionState,
): boolean {
  const session = sessionManager.getSession(sessionId);
  if (!session || session.state === next) return false;
  try {
    sessionManager.updateState(sessionId, next);
  } catch (err) {
    serviceLogger.debug(
      { sessionId, from: session.state, to: next, error: String(err) },
      "updateState rejected",
    );
    return false;
  }
  pushSessionStatus(relay, sessionManager, sessionId);
  return true;
}

function tryConnectSocket(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleResources(): Promise<void> {
  if (existsSync(SOCK_PATH)) {
    const existing = await tryConnectSocket(SOCK_PATH);
    if (existing) {
      existing.destroy();
      const msg = `Another service is already running on ${SOCK_PATH}`;
      serviceLogger.error(msg);
      console.error(msg);
      process.exit(1);
    }
    unlinkSync(SOCK_PATH);
    serviceLogger.info("Removed stale socket file");
  }

  if (existsSync(PID_PATH)) {
    const pidStr = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      const msg = `Another service is already running with PID ${pid}`;
      serviceLogger.error(msg);
      console.error(msg);
      process.exit(1);
    }
    unlinkSync(PID_PATH);
    serviceLogger.info("Removed stale PID file");
  }
}

// ---------- 工具审批 pending 回调管理 ----------

// requestId -> resolve callback，serve 收到 relay 的 tool_approve/tool_deny 时 resolve
const pendingToolApprovals = new Map<
  string,
  {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    workerSocket: Socket;
    resolve: (response: { behavior: "allow" | "deny"; message?: string }) => void;
  }
>();

// ---------- Worker 管理 ----------

// 将 worker 的 claude stream-json 事件路由为类型化 envelope / control message
// 对齐 Claude CLI stream-json 输出: {type: "assistant"|"result"|"system"|"user", ...}
// assistant 事件: 提取 content[] 中 text blocks 发 assistant_message; thinking 单独发 thinking envelope
// tool_use content block 不在此路由, 审批请求走 worker_approval_request 分支
// result 事件: 发 turn_result control, 客户端据此 markTurnComplete
// system/user/其他: 忽略 (无 UI 影响)
function forwardWorkerEvent(
  relayConnection: RelayConnection,
  sessionManager: SessionManager,
  sessionId: string,
  seq: number,
  event: Record<string, unknown>,
): void {
  const type = event.type;
  if (type === "assistant") {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string | undefined) ?? "")
      .join("");
    if (text) {
      relayConnection.sendEnvelope(
        buildMessage("assistant_message", sessionId, seq, { text, isPartial: true }, "proxy"),
      );
    }
    const thinkingBlock = content.find((c) => c.type === "thinking");
    if (thinkingBlock) {
      const thinkingText = (thinkingBlock.thinking as string | undefined) ?? "";
      if (thinkingText) {
        relayConnection.sendEnvelope(
          buildMessage("thinking", sessionId, seq, { text: thinkingText }, "proxy"),
        );
      }
    }
    return;
  }
  if (type === "result") {
    relayConnection.sendRaw(
      JSON.stringify({
        type: "turn_result",
        sessionId,
        success: event.subtype === "success",
        isError: Boolean(event.is_error),
      }),
    );
    // turn 结束 = JSON 会话回 IDLE；changeSessionState 内部会推 session_status envelope
    changeSessionState(sessionManager, relayConnection, sessionId, SessionState.IDLE);
    return;
  }
  // system / user / rate_limit_event 等当前不投给 client
}

function connectToWorker(
  sessionId: string,
  sockPath: string,
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  relayConnection: RelayConnection | null = null,
): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(sockPath);
    sock.on("connect", () => {
      workerSockets.set(sessionId, sock);

      createWorkerReader(sock, (msg: WorkerMessage) => {
        switch (msg.type) {
          case "worker_ready":
            serviceLogger.info({ sessionId, pid: msg.pid }, "Worker ready");
            break;
          case "worker_event":
            // 不在此处改 session.state:
            // Claude CLI 会在启动/连接阶段发 system init 之类的非 turn 事件,
            // 若无条件转 WORKING 会导致新建会话立刻显示"停止"按钮并一直卡住.
            // WORKING 的真正入口是 user_input (见下方 L812); result 事件由 forwardWorkerEvent 负责转 IDLE.
            // 将 worker 事件按 stream-json 语义路由到类型化 envelope / control message
            // event 结构参考 claude CLI stream-json: assistant / result / system / user
            if (relayConnection) {
              try {
                forwardWorkerEvent(relayConnection, sessionManager, sessionId, msg.seq, msg.event);
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
            sessionManager.terminateSession(sessionId);
            workerSockets.delete(sessionId);
            serviceLogger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
            break;
          case "worker_approval_request":
            if (relayConnection) {
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
                relayConnection.sendEnvelope(envelope);
                pendingToolApprovals.set(msg.requestId, {
                  sessionId,
                  toolName: msg.toolName,
                  input: msg.input,
                  workerSocket: sock,
                  resolve: (response) => {
                    sock.write(
                      serializeWorkerMsg({
                        type: "worker_approval_response",
                        requestId: msg.requestId,
                        behavior: response.behavior,
                        message: response.message,
                      }),
                    );
                  },
                });
              } catch (err) {
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
            } else {
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
            }
            break;
          case "worker_claude_session_id":
            sessionManager.setClaudeSessionId(sessionId, msg.sessionId);
            serviceLogger.info(
              { sessionId, claudeSessionId: msg.sessionId },
              "Claude session ID captured",
            );
            break;
        }
      });

      sock.on("close", () => {
        workerSockets.delete(sessionId);
        for (const [requestId, pending] of pendingToolApprovals) {
          if (pending.sessionId === sessionId) {
            pending.resolve({ behavior: "deny", message: "Worker disconnected" });
            pendingToolApprovals.delete(requestId);
            serviceLogger.info(
              { sessionId, requestId },
              "Pending tool approval denied on worker disconnect",
            );
          }
        }
      });
      sock.on("error", () => {
        workerSockets.delete(sessionId);
        for (const [requestId, pending] of pendingToolApprovals) {
          if (pending.sessionId === sessionId) {
            pending.resolve({ behavior: "deny", message: "Worker disconnected" });
            pendingToolApprovals.delete(requestId);
            serviceLogger.info(
              { sessionId, requestId },
              "Pending tool approval denied on worker error",
            );
          }
        }
      });

      resolve(sock);
    });
    sock.on("error", () => resolve(null));
  });
}

function spawnWorker(
  sessionId: string,
  options?: { cwd?: string; resumeSessionId?: string; permissionMode?: string },
): number {
  const paths = sessionPaths(sessionId);

  const workerArgs: string[] = [sessionId, paths.workerSock];
  if (options?.cwd) workerArgs.push("--cwd", options.cwd);
  if (options?.resumeSessionId) workerArgs.push("--resume", options.resumeSessionId);
  // 远程场景默认走 default (每工具审批), 覆盖用户全局 claude settings 的 defaultMode
  workerArgs.push("--permission-mode", options?.permissionMode ?? "default");
  workerArgs.push("--");

  const child = spawnScript(new URL("./session-worker", import.meta.url), workerArgs, {
    logger: serviceLogger,
  });
  const workerPid = child.pid!;
  serviceLogger.info(
    { sessionId, workerPid, cwd: options?.cwd, resume: options?.resumeSessionId },
    "Worker process spawned",
  );
  return workerPid;
}

async function reconnectWorkers(
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  relayConnection: RelayConnection | null = null,
): Promise<void> {
  if (!existsSync(DATA_DIR)) return;

  const dirs = readdirSync(DATA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const sessionId = dir.name;
    const paths = sessionPaths(sessionId);
    if (!existsSync(paths.workerSock)) continue;

    const sock = await connectToWorker(
      sessionId,
      paths.workerSock,
      sessionManager,
      workerSockets,
      relayConnection,
    );
    if (sock) {
      if (!sessionManager.getSession(sessionId)) {
        serviceLogger.warn(
          { sessionId },
          "Orphaned worker found without session data, terminating",
        );
        sock.end();
        workerSockets.delete(sessionId);
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

// ---------- 客户端 IPC 消息处理 ----------

function handleTerminalConnection(
  socket: Socket,
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  terminalSockets: Map<string, Socket>,
  relayConnection: RelayConnection | null = null,
  controlHandlers?: ControlMessageHandlers,
): void {
  createIpcReader(
    socket,
    (msg: IpcMessage) => {
      switch (msg.type) {
        case "session_create_request": {
          if (msg.mode === "pty") {
            const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
            const session =
              existing ??
              sessionManager.createSession("pty", msg.cwd, msg.pid, msg.name, msg.sessionId);
            if (existing) {
              changeSessionState(sessionManager, relayConnection, session.id, SessionState.IDLE);
              sessionManager.setPid(session.id, msg.pid);
            }
            socket.write(
              serializeIpc({
                type: "session_create_response",
                sessionId: session.id,
              }),
            );
            serviceLogger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
          } else {
            const pendingId = nanoid();
            const workerPid = spawnWorker(pendingId);
            const session = sessionManager.createSession(
              "json",
              msg.cwd,
              workerPid,
              msg.name,
              pendingId,
            );

            const paths = sessionPaths(session.id);
            let attempt = 0;
            const maxRetries = 20;
            const tryConnectWorker = () => {
              attempt++;
              connectToWorker(
                session.id,
                paths.workerSock,
                sessionManager,
                workerSockets,
                relayConnection,
              ).then((sock) => {
                if (sock) {
                  socket.write(
                    serializeIpc({
                      type: "session_create_response",
                      sessionId: session.id,
                    }),
                  );
                  serviceLogger.info(
                    { sessionId: session.id, mode: "json" },
                    "JSON session created via worker",
                  );
                  if (relayConnection) {
                    relayConnection.sendRaw(
                      JSON.stringify({
                        type: "session_sync",
                        sessions: [{ id: session.id, mode: session.mode, state: session.state }],
                      }),
                    );
                  }
                } else if (attempt < maxRetries) {
                  setTimeout(tryConnectWorker, Math.min(100 * attempt, 2000));
                } else {
                  socket.write(
                    serializeIpc({
                      type: "session_create_response",
                      sessionId: session.id,
                      error: "Worker failed to start",
                    }),
                  );
                  serviceLogger.error({ sessionId: session.id }, "Worker connection timeout");
                }
              });
            };
            setTimeout(tryConnectWorker, 100);
          }
          break;
        }

        case "service_status_request": {
          const relayStatus = relayConnection?.getStatus() ?? null;
          const sessions = sessionManager.listSessions();
          socket.write(
            serializeIpc({
              type: "service_status_response",
              relay: relayStatus,
              sessions: sessions.map((s) => ({
                id: s.id,
                mode: s.mode,
                state: s.state,
                createdAt: new Date(s.createdAt).toISOString(),
                ...(s.name !== undefined ? { name: s.name } : {}),
                hasWorker: workerSockets.has(s.id),
              })),
            }),
          );
          break;
        }

        case "pty_title_change": {
          // terminal → serve → relay：转发终端标题变化
          if (relayConnection) {
            relayConnection.sendRaw(
              JSON.stringify({
                type: "terminal_title",
                sessionId: msg.sessionId,
                title: msg.title,
              }),
            );
          }
          break;
        }

        case "pty_state_push": {
          // terminal → serve → relay：PTY 语义状态变化
          const stateMap: Record<string, SessionState> = {
            working: SessionState.WORKING,
            turn_complete: SessionState.IDLE,
            approval_wait: SessionState.WAITING_APPROVAL,
          };
          const sessionState = stateMap[msg.state];
          if (sessionState) {
            changeSessionState(sessionManager, relayConnection, msg.sessionId, sessionState);
          }
          if (relayConnection) {
            relayConnection.sendRaw(
              JSON.stringify({
                type: "pty_state",
                sessionId: msg.sessionId,
                payload: {
                  state: msg.state,
                  ...(msg.title !== undefined ? { title: msg.title } : {}),
                  ...(msg.tool !== undefined ? { tool: msg.tool } : {}),
                },
              }),
            );
          }
          break;
        }

        case "pty_resize": {
          // terminal → serve → relay：转发终端尺寸变化
          if (relayConnection) {
            relayConnection.sendRaw(
              JSON.stringify({
                type: "terminal_resize",
                sessionId: msg.sessionId,
                cols: msg.cols,
                rows: msg.rows,
              }),
            );
          }
          break;
        }

        case "session_terminate_request": {
          const result = sessionManager.terminateSession(msg.sessionId);
          const ws = workerSockets.get(msg.sessionId);
          if (ws?.writable) {
            ws.write(serializeWorkerMsg({ type: "worker_stop" }));
          }
          workerSockets.delete(msg.sessionId);

          controlHandlers?.cleanup(msg.sessionId);
          socket.write(
            serializeIpc({
              type: "session_terminate_response",
              sessionId: msg.sessionId,
              success: result.success,
            }),
          );
          serviceLogger.info(
            { sessionId: msg.sessionId, success: result.success },
            "Session terminated",
          );
          break;
        }

        case "pty_register": {
          changeSessionState(sessionManager, relayConnection, msg.sessionId, SessionState.IDLE);
          sessionManager.setPid(msg.sessionId, msg.pid);
          terminalSockets.set(msg.sessionId, socket);
          // 注册即告知当前 bridge 状态，避免新接入的终端要等下次状态翻转才知道
          if (relayConnection) {
            socket.write(
              serializeIpc({
                type: "bridge_status",
                connected: relayConnection.getStatus().connected,
              }),
            );
          }
          // 通知 relay 该 session 存在，并推送会话列表给客户端
          if (relayConnection) {
            const session = sessionManager.getSession(msg.sessionId);
            if (session) {
              relayConnection.sendRaw(
                JSON.stringify({
                  type: "session_sync",
                  sessions: [{ id: session.id, mode: session.mode, state: session.state }],
                }),
              );
            }
            const allSessions = sessionManager.listSessions();
            relayConnection.sendRaw(
              JSON.stringify({
                type: "session_list",
                sessionId: "",
                seq: 0,
                timestamp: Date.now(),
                source: "proxy",
                version: "1",
                payload: {
                  sessions: allSessions.map(toSessionListPayload),
                },
              }),
            );
          }
          serviceLogger.info({ sessionId: msg.sessionId }, "PTY session registered");
          break;
        }

        case "pty_deregister": {
          // 先通知客户端状态变更，再清理 session
          if (relayConnection) {
            relayConnection.sendRaw(
              JSON.stringify({
                type: "pty_state",
                sessionId: msg.sessionId,
                payload: { state: "turn_complete" },
              }),
            );
          }
          sessionManager.terminateSession(msg.sessionId);
          terminalSockets.delete(msg.sessionId);

          controlHandlers?.cleanup(msg.sessionId);
          // 推送更新后的会话列表给客户端
          if (relayConnection) {
            const remaining = sessionManager.listSessions();
            relayConnection.sendRaw(
              JSON.stringify({
                type: "session_list",
                sessionId: "",
                seq: 0,
                timestamp: Date.now(),
                source: "proxy",
                version: "1",
                payload: {
                  sessions: remaining.map(toSessionListPayload),
                },
              }),
            );
          }
          serviceLogger.info({ sessionId: msg.sessionId }, "PTY session deregistered");
          break;
        }

        case "pty_input": {
          const targetSocket = terminalSockets.get(msg.sessionId);
          if (targetSocket?.writable) {
            targetSocket.write(
              serializeIpc({
                type: "pty_input",
                sessionId: msg.sessionId,
                data: msg.data,
              }),
            );
          }
          break;
        }

        case "session_status_update": {
          changeSessionState(sessionManager, relayConnection, msg.sessionId, msg.state);
          break;
        }

        case "pty_snapshot": {
          // terminal serialize() 结果转发给 relay → client
          if (relayConnection) {
            relayConnection.sendRaw(
              JSON.stringify({
                type: "session_snapshot",
                sessionId: msg.sessionId,
                cols: msg.cols,
                rows: msg.rows,
                data: msg.data,
              }),
            );
            serviceLogger.info(
              { sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows },
              "Session snapshot forwarded to relay",
            );
          }
          break;
        }

        default: {
          serviceLogger.warn({ type: (msg as IpcMessage).type }, "Unhandled IPC message type");
        }
      }
    },
    (sessionId, data) => {
      // WebSocket binary 帧格式: [1B sessionId_len][sessionId UTF-8][PTY data]
      if (relayConnection) {
        const sessionIdBuf = Buffer.from(sessionId, "utf-8");
        const wsFrame = Buffer.alloc(1 + sessionIdBuf.length + data.length);
        wsFrame[0] = sessionIdBuf.length;
        sessionIdBuf.copy(wsFrame, 1);
        data.copy(wsFrame, 1 + sessionIdBuf.length);
        relayConnection.sendBinary(wsFrame);
      }
    },
  );

  socket.on("close", () => {
    for (const [sessionId, terminalSocket] of terminalSockets) {
      if (terminalSocket === socket) {
        terminalSockets.delete(sessionId);
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          // pty_deregister 已完成清理
          serviceLogger.info({ sessionId }, "Terminal socket closed, session already cleaned");
          continue;
        }
        if (session.mode === "pty" && session.pid && isProcessAlive(session.pid)) {
          // terminal 进程仍存活，serve 正在重启，不做清理
          serviceLogger.info(
            { sessionId, pid: session.pid },
            "Terminal socket closed but process alive, skipping cleanup",
          );
          continue;
        }
        // terminal 进程已死（crash），执行完整清理
        if (relayConnection) {
          relayConnection.sendRaw(
            JSON.stringify({
              type: "pty_state",
              sessionId,
              payload: { state: "turn_complete" },
            }),
          );
        }
        sessionManager.terminateSession(sessionId);
        controlHandlers?.cleanup(sessionId);
        if (relayConnection) {
          const remaining = sessionManager.listSessions();
          relayConnection.sendRaw(
            JSON.stringify({
              type: "session_list",
              sessionId: "",
              seq: 0,
              timestamp: Date.now(),
              source: "proxy",
              version: "1",
              payload: {
                sessions: remaining.map(toSessionListPayload),
              },
            }),
          );
        }
        serviceLogger.info(
          { sessionId },
          "PTY session cleaned up on socket close (crash fallback)",
        );
      }
    }
  });

  socket.on("error", (err) => {
    serviceLogger.warn({ error: String(err) }, "Client socket error");
  });
}

// ---------- 服务入口 ----------

export interface ServiceOptions {
  relayUrl?: string;
}

export async function startService(options?: ServiceOptions): Promise<void> {
  await cleanupStaleResources();
  try {
    unlinkSync(STOPPED_PATH);
  } catch {
    // STOPPED 文件不存在时忽略
  }

  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    onSessionRemoved: (id) => {
      const paths = sessionPaths(id);
      try {
        rmSync(paths.dir, { recursive: true, force: true });
      } catch {
        // 会话目录清理失败不影响主流程
      }
    },
  });
  sessionManager.startReaper();

  const workerSockets = new Map<string, Socket>();
  const terminalSockets = new Map<string, Socket>();
  // proxy 名称，优先环境变量，其次 macOS ComputerName，最后 os.hostname()
  const proxyName = process.env.CC_ANYWHERE_PROXY_NAME || getComputerName() || hostname();

  function getComputerName(): string | null {
    try {
      return (
        execSync("scutil --get ComputerName", { stdio: ["pipe", "pipe", "ignore"] })
          .toString()
          .trim() || null
      );
    } catch {
      return null;
    }
  }

  // 创建 handler 模块实例（在 relay 连接建立前创建，send 函数延迟绑定）
  let relaySend: ((data: string) => void) | null = null;
  const controlHandlers = createControlMessageHandlers((data) => {
    if (relaySend) relaySend(data);
  }, sessionManager);

  // 连接中转服务器：优先用调用方传入的 relayUrl，否则从配置文件读取
  const proxyConfig = loadConfig();
  const relayUrl = options?.relayUrl ?? proxyConfig.relayUrl;
  const relayToken = proxyConfig.relayToken;
  let relayConnection: RelayConnection | null = null;

  if (relayUrl) {
    relayConnection = new RelayConnection(relayUrl, { name: proxyName, token: relayToken });
    relaySend = (data) => relayConnection!.sendRaw(data);
    relayConnection.connect();
    serviceLogger.info(
      { relayUrl, proxyName, tokenSet: !!relayToken },
      "Connecting to relay server",
    );

    // 重连时 RelayConnection 自动 flush 离线队列，不需要本地回放

    // 处理来自 remote client 的消息（信封消息和控制消息）
    relayConnection.on("message", (data: string) => {
      try {
        const parsed = JSON.parse(data);

        // 信封消息：user_input, tool_approve, tool_deny
        if (parsed.type === "user_input" && parsed.sessionId) {
          const session = sessionManager.getSession(parsed.sessionId);
          if (!session) {
            serviceLogger.warn(
              { sessionId: parsed.sessionId },
              "Remote input dropped: session not found",
            );
          } else if (session.mode === "json") {
            const ws = workerSockets.get(parsed.sessionId);
            if (ws?.writable) {
              // user_input 是 JSON turn 的唯一入口, 此刻就推 WORKING, 不再依赖 worker_event 的副作用
              changeSessionState(
                sessionManager,
                relayConnection,
                parsed.sessionId,
                SessionState.WORKING,
              );
              ws.write(
                serializeWorkerMsg({
                  type: "worker_input",
                  content: parsed.payload?.text ?? "",
                }),
              );
              serviceLogger.info(
                { sessionId: parsed.sessionId },
                "Remote input forwarded to JSON worker",
              );
            } else {
              serviceLogger.warn(
                { sessionId: parsed.sessionId },
                "Remote input dropped: JSON worker socket not available",
              );
            }
          } else {
            const ts = terminalSockets.get(parsed.sessionId);
            if (ts?.writable) {
              ts.write(
                serializeIpc({
                  type: "pty_input",
                  sessionId: parsed.sessionId,
                  data: (parsed.payload?.text ?? "") + "\r",
                }),
              );
              serviceLogger.info(
                { sessionId: parsed.sessionId },
                "Remote input forwarded to PTY terminal",
              );
            } else {
              serviceLogger.warn(
                { sessionId: parsed.sessionId },
                "Remote input dropped: PTY terminal socket not available",
              );
            }
          }
        } else if (parsed.type === "remote_input_raw" && parsed.sessionId) {
          // 远程语义动作面板发来的原始 ANSI 字节，直接写入 PTY stdin，不追加 \r
          const ts = terminalSockets.get(parsed.sessionId);
          if (ts?.writable) {
            ts.write(
              serializeIpc({
                type: "pty_input",
                sessionId: parsed.sessionId,
                data: parsed.data,
              }),
            );
            serviceLogger.info(
              { sessionId: parsed.sessionId, bytes: parsed.data.length },
              "Raw PTY input forwarded",
            );
          } else {
            serviceLogger.warn(
              { sessionId: parsed.sessionId },
              "Raw PTY input dropped: terminal socket unavailable",
            );
          }
        } else if (parsed.type === "tool_approve" && parsed.sessionId) {
          const toolId = parsed.payload?.toolId as string | undefined;
          const whitelistTool = parsed.payload?.whitelistTool as boolean | undefined;
          if (toolId) {
            const pending = pendingToolApprovals.get(toolId);
            if (pending) {
              pending.resolve({ behavior: "allow" });
              pendingToolApprovals.delete(toolId);
              // whitelistTool 为 true 时将工具加入会话级白名单
              if (whitelistTool) {
                const toolName = (parsed.payload?.toolName as string) ?? "";
                if (toolName && pending.workerSocket.writable) {
                  pending.workerSocket.write(
                    serializeWorkerMsg({
                      type: "worker_whitelist_add",
                      toolName,
                    }),
                  );
                  serviceLogger.info(
                    { sessionId: pending.sessionId, toolName },
                    "Tool added to session whitelist via relay",
                  );
                }
              }
              serviceLogger.info(
                { sessionId: parsed.sessionId, toolId, whitelistTool },
                "Tool approved via relay",
              );
            }
          }
        } else if (parsed.type === "tool_deny" && parsed.sessionId) {
          const toolId = parsed.payload?.toolId as string | undefined;
          const reason = (parsed.payload?.reason as string) ?? "Denied by remote user";
          if (toolId) {
            const pending = pendingToolApprovals.get(toolId);
            if (pending) {
              pending.resolve({ behavior: "deny", message: reason });
              pendingToolApprovals.delete(toolId);
              serviceLogger.info({ sessionId: parsed.sessionId, toolId }, "Tool denied via relay");
            }
          }
        }
        // 控制消息：dir_list_request, session_history_request 等
        else if (parsed.type === "proxy_info_request") {
          relaySend!(
            JSON.stringify({
              type: "proxy_info",
              homePath: homedir() || "/",
            }),
          );
        } else if (parsed.type === "dir_list_request") {
          controlHandlers.handleDirListRequest({ path: parsed.path ?? "" });
        } else if (parsed.type === "dir_create_request") {
          controlHandlers.handleDirCreateRequest({ path: parsed.path ?? "" });
        } else if (parsed.type === "session_create" && parsed.cwd) {
          const cwd = parsed.cwd as string;
          const resumeSessionId = parsed.resumeSessionId as string | undefined;
          const permissionMode = parsed.permissionMode as string | undefined;
          const name = tildify(cwd);
          // 先生成 ID 和启动 worker，连接成功后再注册 session
          const pendingId = nanoid();
          const workerPid = spawnWorker(pendingId, { cwd, resumeSessionId, permissionMode });

          const paths = sessionPaths(pendingId);
          let attempt = 0;
          const maxRetries = 20;
          const tryConnect = () => {
            attempt++;
            connectToWorker(
              pendingId,
              paths.workerSock,
              sessionManager,
              workerSockets,
              relayConnection,
            ).then((sock) => {
              if (sock) {
                // worker 连接成功，正式注册 session
                const session = sessionManager.createSession(
                  "json",
                  cwd,
                  workerPid,
                  name,
                  pendingId,
                );
                if (resumeSessionId) {
                  sessionManager.setClaudeSessionId(session.id, resumeSessionId);
                }
                relaySend!(
                  JSON.stringify({
                    type: "session_create_response",
                    sessionId: session.id,
                  }),
                );
                if (resumeSessionId) {
                  readSessionMessages(resumeSessionId)
                    .then((messages) => {
                      if (messages.length > 0) {
                        relaySend!(
                          JSON.stringify({
                            type: "session_history_messages",
                            sessionId: session.id,
                            messages,
                          }),
                        );
                        serviceLogger.info(
                          { sessionId: session.id, resumeSessionId, messageCount: messages.length },
                          "History messages sent for resumed session",
                        );
                      }
                    })
                    .catch((err) => {
                      serviceLogger.warn(
                        { sessionId: session.id, error: String(err) },
                        "Failed to read session history messages",
                      );
                    });
                }
                serviceLogger.info(
                  { sessionId: session.id, cwd },
                  "JSON session created via relay",
                );
                controlHandlers.pushCommandList(session.id, cwd);
                if (relayConnection) {
                  relayConnection.sendRaw(
                    JSON.stringify({
                      type: "session_sync",
                      sessions: [{ id: session.id, mode: session.mode, state: session.state }],
                    }),
                  );
                  const sessions = sessionManager.listSessions();
                  relayConnection.sendRaw(
                    JSON.stringify({
                      type: "session_list",
                      sessionId: "",
                      seq: 0,
                      timestamp: Date.now(),
                      source: "proxy",
                      version: "1",
                      payload: { sessions: sessions.map(toSessionListPayload) },
                    }),
                  );
                }
              } else if (attempt < maxRetries) {
                setTimeout(tryConnect, Math.min(100 * attempt, 2000));
              } else {
                relaySend!(
                  JSON.stringify({
                    type: "session_create_response",
                    sessionId: pendingId,
                    error: "Worker failed to start",
                  }),
                );
                serviceLogger.error(
                  { sessionId: pendingId },
                  "Worker connection timeout via relay",
                );
              }
            });
          };
          setTimeout(tryConnect, 100);
        } else if (parsed.type === "session_messages_request") {
          const sid = parsed.sessionId as string;
          const session = sessionManager.getSession(sid);
          if (session?.claudeSessionId) {
            readSessionMessages(session.claudeSessionId)
              .then((messages) => {
                if (relaySend) {
                  relaySend(
                    JSON.stringify({
                      type: "session_history_messages",
                      sessionId: sid,
                      messages,
                    }),
                  );
                  serviceLogger.info(
                    { sessionId: sid, messageCount: messages.length },
                    "History messages sent on request",
                  );
                }
              })
              .catch((err) => {
                serviceLogger.warn(
                  { sessionId: sid, error: String(err) },
                  "Failed to read session history messages on request",
                );
                if (relaySend) {
                  relaySend(
                    JSON.stringify({
                      type: "session_history_messages",
                      sessionId: sid,
                      messages: [],
                    }),
                  );
                }
              });
          } else if (relaySend) {
            // 非 resume 会话，没有历史消息，回空列表解除 loading
            relaySend(
              JSON.stringify({ type: "session_history_messages", sessionId: sid, messages: [] }),
            );
          }
          // 推送该 session 当前 pending 的工具审批
          if (relaySend) {
            const approvals: Array<{
              requestId: string;
              toolName: string;
              input: Record<string, unknown>;
            }> = [];
            for (const [requestId, pending] of pendingToolApprovals) {
              if (pending.sessionId === sid) {
                approvals.push({ requestId, toolName: pending.toolName, input: pending.input });
              }
            }
            if (approvals.length > 0) {
              relaySend(
                JSON.stringify({ type: "pending_approvals_push", sessionId: sid, approvals }),
              );
              serviceLogger.info(
                { sessionId: sid, count: approvals.length },
                "Pending approvals pushed",
              );
            }
          }
        } else if (parsed.type === "session_resources_request") {
          const sid = parsed.sessionId as string;
          const session = sessionManager.getSession(sid);
          if (session?.cwd) {
            controlHandlers.pushCommandList(sid, session.cwd);
            controlHandlers.pushFileTree(sid, session.cwd);
            serviceLogger.info({ sessionId: sid, cwd: session.cwd }, "Session resources pushed");
          } else {
            serviceLogger.warn({ sessionId: sid }, "Session resources request: no cwd available");
          }
        } else if (parsed.type === "session_terminate") {
          const sid = parsed.sessionId as string;
          const result = sessionManager.terminateSession(sid);
          const ws = workerSockets.get(sid);
          if (ws?.writable) {
            ws.write(serializeWorkerMsg({ type: "worker_stop" }));
          }
          workerSockets.delete(sid);
          controlHandlers.cleanup(sid);
          serviceLogger.info(
            { sessionId: sid, success: result.success },
            "Session terminated via relay",
          );
          // 推送更新后的 session 列表
          if (relayConnection) {
            const sessions = sessionManager.listSessions();
            relayConnection.sendRaw(
              JSON.stringify({
                type: "session_list",
                sessionId: "",
                seq: 0,
                timestamp: Date.now(),
                source: "proxy",
                version: "1",
                payload: { sessions: sessions.map(toSessionListPayload) },
              }),
            );
          }
        } else if (parsed.type === "session_worker_abort") {
          const sid = parsed.sessionId as string;
          const session = sessionManager.getSession(sid);
          if (!session) {
            serviceLogger.warn({ sessionId: sid }, "session_worker_abort: session not found");
          } else if (session.state === SessionState.TERMINATED) {
            serviceLogger.info(
              { sessionId: sid },
              "session_worker_abort: already terminated, dropping",
            );
          } else if (session.mode === "pty") {
            // PTY 会话直接把 Ctrl+C 写入 PTY stdin，避免杀掉 terminal wrapper 进程
            const ts = terminalSockets.get(sid);
            if (ts?.writable) {
              ts.write(serializeIpc({ type: "pty_input", sessionId: sid, data: "\x03" }));
              serviceLogger.info({ sessionId: sid }, "session_worker_abort: Ctrl+C sent to PTY");
            } else {
              serviceLogger.warn(
                { sessionId: sid },
                "session_worker_abort: PTY terminal socket unavailable",
              );
            }
          } else {
            try {
              process.kill(session.pid, "SIGINT");
              serviceLogger.info(
                { sessionId: sid, pid: session.pid },
                "session_worker_abort: SIGINT sent to worker",
              );
            } catch (err) {
              serviceLogger.warn(
                { sessionId: sid, pid: session.pid, error: String(err) },
                "session_worker_abort: kill failed",
              );
            }
          }
        } else if (parsed.type === "session_history_request") {
          controlHandlers.handleSessionHistoryRequest();
        } else if (parsed.type === "session_list") {
          const sessions = sessionManager.listSessions();
          relaySend!(
            JSON.stringify({
              type: "session_list",
              sessionId: "",
              seq: 0,
              timestamp: Date.now(),
              source: "proxy",
              version: "1",
              payload: { sessions: sessions.map(toSessionListPayload) },
            }),
          );
          serviceLogger.info("Session list sent via relay");
        } else if (parsed.type === "permission_mode_change") {
          const sid = (parsed as { sessionId?: string }).sessionId;
          const mode = parsed.mode;
          if (sid) {
            const session = sessionManager.getSession(sid);
            if (session?.mode === "pty") {
              // PTY 会话：发 Shift+Tab (CSI Z) 让 claude CLI 循环 permission mode
              // mode 字段当前保留但不使用 —— Claude CLI 仅支持循环键，无法一键直选档位
              const ts = terminalSockets.get(sid);
              if (ts?.writable) {
                ts.write(serializeIpc({ type: "pty_input", sessionId: sid, data: "\x1b[Z" }));
                serviceLogger.info(
                  { sessionId: sid, mode },
                  "Permission mode cycle: Shift+Tab sent to PTY",
                );
              } else {
                serviceLogger.warn(
                  { sessionId: sid },
                  "Permission mode cycle: PTY terminal socket unavailable",
                );
              }
            } else {
              serviceLogger.info(
                { sessionId: sid, mode },
                "Permission mode change received for JSON session (no-op, not supported)",
              );
            }
          } else {
            serviceLogger.info(
              { mode },
              "Permission mode change received via relay (global, no sessionId)",
            );
          }
        } else if (parsed.type === "session_subscribe" && parsed.sessionId) {
          const sid = parsed.sessionId as string;
          const ts = terminalSockets.get(sid);
          if (ts?.writable) {
            ts.write(serializeIpc({ type: "pty_subscribe", sessionId: sid }));
            serviceLogger.info({ sessionId: sid }, "Subscribe forwarded to terminal");
          } else {
            serviceLogger.warn(
              { sessionId: sid },
              "Subscribe failed: terminal socket not available",
            );
          }
        }
      } catch (err) {
        serviceLogger.warn({ error: String(err) }, "Failed to parse relay message");
      }
    });

    // relay 重连时重新推送控制数据
    relayConnection.on("connected", () => {
      controlHandlers.reinitializeOnReconnect();
      broadcastBridgeStatus(true);
    });
    relayConnection.on("disconnected", () => {
      broadcastBridgeStatus(false);
    });
  } else {
    serviceLogger.info("No RELAY_URL configured, relay connection disabled");
  }

  // 把 relay 连接状态广播给所有已注册的 terminal，终端进程会 stderr 打 banner 提示用户
  function broadcastBridgeStatus(connected: boolean): void {
    const msg = serializeIpc({ type: "bridge_status", connected });
    for (const [, sock] of terminalSockets) {
      if (sock.writable) sock.write(msg);
    }
  }

  await reconnectWorkers(sessionManager, workerSockets, relayConnection);

  const server = createServer((socket) => {
    handleTerminalConnection(
      socket,
      sessionManager,
      workerSockets,
      terminalSockets,
      relayConnection,
      controlHandlers,
    );
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    chmodSync(SOCK_PATH, 0o600);
    serviceLogger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
  });

  async function shutdown(): Promise<void> {
    serviceLogger.info("Shutting down service");
    sessionManager.stopReaper();
    if (relayConnection) {
      relayConnection.close();
    }
    for (const [, ws] of workerSockets) {
      ws.destroy();
    }
    workerSockets.clear();
    server.close();
    try {
      unlinkSync(SOCK_PATH);
    } catch {
      // 关闭时 socket 文件可能已被删除
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // 关闭时 PID 文件可能已被删除
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    shutdown();
  });
  process.on("SIGINT", () => {
    shutdown();
  });
}

const isMainModule =
  process.argv[1] && (process.argv[1].endsWith("serve.js") || process.argv[1].endsWith("serve.ts"));

if (isMainModule) {
  startService();
}
