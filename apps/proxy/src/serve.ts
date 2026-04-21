import { createServer, connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { SessionState, buildMessage } from "@cc-anywhere/shared";
import { serviceLogger } from "./common/logger.js";
import { SessionManager, type SessionInfo } from "./serve/session-manager.js";
import { RelayConnection } from "./serve/relay-connection.js";
import { homedir } from "node:os";
import {
  SOCK_PATH,
  PID_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  sessionPaths,
  tildify,
} from "./common/paths.js";
import { loadConfig } from "./common/config.js";
import {
  createIpcReader,
  serializeIpc,
  serializeWorkerMsg,
  type IpcMessage,
} from "./ipc/ipc-protocol.js";
import { nanoid } from "nanoid";
import {
  createControlMessageHandlers,
  type ControlMessageHandlers,
} from "./serve/handlers/control-messages.js";
import { readSessionMessages } from "./serve/session-history.js";
import { ToolApprovalManager } from "./serve/tool-approval-manager.js";
import { WorkerRegistry } from "./serve/worker-registry.js";

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

// 广播当前全量 session 列表给 relay → client，UI 列表页靠这个刷新
function broadcastSessionList(relay: RelayConnection | null, sessionManager: SessionManager): void {
  if (!relay) return;
  relay.sendRaw(
    JSON.stringify({
      type: "session_list",
      sessionId: "",
      seq: 0,
      timestamp: Date.now(),
      source: "proxy",
      version: "1",
      payload: { sessions: sessionManager.listSessions().map(toSessionListPayload) },
    }),
  );
}

// 通知 relay 单个 session 的存在/状态（仅 id/mode/state），relay 据此建立 proxy-session 关联
function broadcastSessionSync(relay: RelayConnection | null, session: SessionInfo): void {
  if (!relay) return;
  relay.sendRaw(
    JSON.stringify({
      type: "session_sync",
      sessions: [{ id: session.id, mode: session.mode, state: session.state }],
    }),
  );
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

// ---------- 客户端 IPC 消息处理 ----------

function handleTerminalConnection(
  socket: Socket,
  sessionManager: SessionManager,
  workerRegistry: WorkerRegistry,
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
            const workerPid = workerRegistry.spawn(pendingId);
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
              workerRegistry.connect(session.id, paths.workerSock).then((sock) => {
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
                  broadcastSessionSync(relayConnection, session);
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
                hasWorker: workerRegistry.has(s.id),
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
          const ws = workerRegistry.getSocket(msg.sessionId);
          if (ws?.writable) {
            ws.write(serializeWorkerMsg({ type: "worker_stop" }));
          }
          workerRegistry.delete(msg.sessionId);

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
              broadcastSessionSync(relayConnection, session);
            }
            broadcastSessionList(relayConnection, sessionManager);
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
          broadcastSessionList(relayConnection, sessionManager);
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
        broadcastSessionList(relayConnection, sessionManager);
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

  const terminalSockets = new Map<string, Socket>();
  const toolApprovalManager = new ToolApprovalManager();
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
  const relayConnection: RelayConnection | null = relayUrl
    ? new RelayConnection(relayUrl, { name: proxyName, token: relayToken })
    : null;
  if (relayConnection) {
    relaySend = (data) => relayConnection.sendRaw(data);
  }

  // WorkerRegistry 需要 relayConnection 引用来转发 worker 事件；建在 relay 之后、listener 之前
  const workerRegistry = new WorkerRegistry({
    sessionManager,
    toolApprovalManager,
    relayConnection,
    changeSessionState: (sessionId, next) =>
      changeSessionState(sessionManager, relayConnection, sessionId, next),
  });

  if (relayConnection) {
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
            const ws = workerRegistry.getSocket(parsed.sessionId);
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
            const pending = toolApprovalManager.take(toolId);
            if (pending) {
              toolApprovalManager.respond(pending, toolId, { behavior: "allow" });
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
            const pending = toolApprovalManager.take(toolId);
            if (pending) {
              toolApprovalManager.respond(pending, toolId, { behavior: "deny", message: reason });
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
          const workerPid = workerRegistry.spawn(pendingId, {
            cwd,
            resumeSessionId,
            permissionMode,
          });

          const paths = sessionPaths(pendingId);
          let attempt = 0;
          const maxRetries = 20;
          const tryConnect = () => {
            attempt++;
            workerRegistry.connect(pendingId, paths.workerSock).then((sock) => {
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
                broadcastSessionSync(relayConnection, session);
                broadcastSessionList(relayConnection, sessionManager);
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
            const approvals = toolApprovalManager.listSession(sid);
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
          const ws = workerRegistry.getSocket(sid);
          if (ws?.writable) {
            ws.write(serializeWorkerMsg({ type: "worker_stop" }));
          }
          workerRegistry.delete(sid);
          controlHandlers.cleanup(sid);
          serviceLogger.info(
            { sessionId: sid, success: result.success },
            "Session terminated via relay",
          );
          broadcastSessionList(relayConnection, sessionManager);
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
          broadcastSessionList(relayConnection, sessionManager);
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
        } else {
          serviceLogger.warn({ type: parsed.type }, "Unhandled relay message type");
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

  await workerRegistry.reconnectAll();

  const server = createServer((socket) => {
    handleTerminalConnection(
      socket,
      sessionManager,
      workerRegistry,
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
    workerRegistry.destroyAll();
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
