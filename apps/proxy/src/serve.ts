import { createServer, connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import {
  unlinkSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import pino from "pino";
import { SessionState, buildMessage } from "@cc-anywhere/shared";
import { SessionManager } from "./session-manager.js";
import { RelayConnection } from "./relay-connection.js";
import { SeqCounter } from "./seq-counter.js";
import {
  SOCK_PATH,
  PID_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  LOG_PATH,
  DATA_DIR,
  sessionPaths,
} from "./paths.js";
import {
  createIpcReader,
  serializeIpc,
  createWorkerReader,
  serializeWorkerMsg,
  type IpcMessage,
  type WorkerMessage,
} from "./ipc-protocol.js";
import { createControlMessageHandlers, type ControlMessageHandlers } from "./handlers/control-messages.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let logger: pino.Logger;

// ---------- 基础工具函数 ----------

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
      logger.error(msg);
      console.error(msg);
      process.exit(1);
    }
    unlinkSync(SOCK_PATH);
    logger.info("Removed stale socket file");
  }

  if (existsSync(PID_PATH)) {
    const pidStr = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      const msg = `Another service is already running with PID ${pid}`;
      logger.error(msg);
      console.error(msg);
      process.exit(1);
    }
    unlinkSync(PID_PATH);
    logger.info("Removed stale PID file");
  }
}

// ---------- 文件 mtime 检测 idle/working ----------

function getEventFileMtime(sessionId: string): number | null {
  const paths = sessionPaths(sessionId);
  try {
    return statSync(paths.events).mtimeMs;
  } catch {
    return null;
  }
}

// ---------- 工具审批 pending 回调管理 ----------

// requestId -> resolve callback，serve 收到 relay 的 tool_approve/tool_deny 时 resolve
const pendingToolApprovals = new Map<
  string,
  {
    sessionId: string;
    workerSocket: Socket;
    resolve: (response: { behavior: "allow" | "deny"; message?: string }) => void;
  }
>();

// sessionId -> Claude session ID，worker 捕获 system 事件后上报
const claudeSessionIds = new Map<string, string>();

// ---------- Worker 管理 ----------

function connectToWorker(
  sessionId: string,
  sockPath: string,
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  terminalSockets: Map<string, Socket>,
  relayConnection: RelayConnection | null = null,
): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(sockPath);
    sock.on("connect", () => {
      workerSockets.set(sessionId, sock);

      createWorkerReader(sock, (msg: WorkerMessage) => {
        switch (msg.type) {
          case "worker_ready":
            sessionManager.setPid(sessionId, msg.pid);
            logger.info({ sessionId, pid: msg.pid }, "Worker ready");
            break;
          case "worker_event":
            for (const [, terminalSocket] of terminalSockets) {
              if (terminalSocket.writable) {
                terminalSocket.write(
                  serializeIpc({
                    type: "session_status_update",
                    sessionId,
                    state: SessionState.WORKING,
                  }),
                );
              }
            }
            // 将 worker 事件转发到 relay
            if (relayConnection) {
              try {
                const envelope = buildMessage(
                  "assistant_message",
                  sessionId,
                  msg.seq,
                  { text: JSON.stringify(msg.event), isPartial: true },
                  "proxy",
                );
                relayConnection.send(envelope);
              } catch (err) {
                logger.debug({ sessionId, error: String(err) }, "Failed to forward event to relay");
              }
            }
            logger.debug({ sessionId, eventType: msg.event.type }, "JSON session event");
            break;
          case "worker_replay_done":
            logger.info({ sessionId, replayedCount: msg.replayedCount }, "Worker event replay complete");
            break;
          case "worker_exit":
            sessionManager.terminateSession(sessionId);
            workerSockets.delete(sessionId);
            logger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
            break;
          case "worker_approval_request":
            if (relayConnection) {
              logger.info({ sessionId, toolName: msg.toolName, requestId: msg.requestId }, "Tool approval forwarding to relay");
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
                relayConnection.send(envelope);
                pendingToolApprovals.set(msg.requestId, {
                  sessionId,
                  workerSocket: sock,
                  resolve: (response) => {
                    sock.write(serializeWorkerMsg({
                      type: "worker_approval_response",
                      requestId: msg.requestId,
                      behavior: response.behavior,
                      message: response.message,
                    }));
                  },
                });
              } catch (err) {
                logger.warn({ sessionId, error: String(err) }, "Failed to forward tool approval to relay, denying");
                sock.write(serializeWorkerMsg({
                  type: "worker_approval_response",
                  requestId: msg.requestId,
                  behavior: "deny",
                  message: "Failed to forward approval request to relay.",
                }));
              }
            } else {
              logger.info({ sessionId, toolName: msg.toolName }, "Tool approval denied (no relay connection)");
              sock.write(serializeWorkerMsg({
                type: "worker_approval_response",
                requestId: msg.requestId,
                behavior: "deny",
                message: "No relay connection available for remote approval.",
              }));
            }
            break;
          case "worker_claude_session_id":
            claudeSessionIds.set(sessionId, msg.sessionId);
            logger.info({ sessionId, claudeSessionId: msg.sessionId }, "Claude session ID captured");
            break;
        }
      });

      sock.on("close", () => { workerSockets.delete(sessionId); });
      sock.on("error", () => { workerSockets.delete(sessionId); });

      resolve(sock);
    });
    sock.on("error", () => resolve(null));
  });
}

function spawnWorker(sessionId: string): void {
  const workerPath = join(__dirname, "session-worker.js");
  const paths = sessionPaths(sessionId);

  const child = spawn(process.execPath, [workerPath, sessionId, paths.workerSock, "--"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logger.info({ sessionId, workerPid: child.pid }, "Worker process spawned");
}

async function reconnectWorkers(
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  terminalSockets: Map<string, Socket>,
  relayConnection: RelayConnection | null = null,
): Promise<void> {
  if (!existsSync(DATA_DIR)) return;

  const dirs = readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const sessionId = dir.name;
    const paths = sessionPaths(sessionId);
    if (!existsSync(paths.workerSock)) continue;

    const sock = await connectToWorker(
      sessionId, paths.workerSock, sessionManager, workerSockets, terminalSockets, relayConnection,
    );
    if (sock) {
      if (!sessionManager.getSession(sessionId)) {
        sessionManager.createSession("json", undefined, sessionId);
      }
      try {
        sessionManager.updateState(sessionId, SessionState.IDLE);
      } catch {
        // 会话状态更新失败不影响重连流程
      }
      logger.info({ sessionId }, "Reconnected to existing worker");
    } else {
      try { unlinkSync(paths.workerSock); } catch {
        // socket 文件可能已被删除
      }
      logger.info({ sessionId }, "Cleaned up stale worker socket");
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
  lastTerminalFrames?: Map<string, string>,
): void {
  createIpcReader(socket, (msg: IpcMessage) => {
    switch (msg.type) {
      case "session_create_request": {
        if (msg.mode === "pty") {
          const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
          const session = existing ?? sessionManager.createSession("pty", msg.name, msg.sessionId);
          if (existing) {
            try { sessionManager.updateState(session.id, SessionState.IDLE); } catch {
              // 已存在的 PTY 会话状态更新失败不阻断创建流程
            }
          }
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
            }),
          );
          logger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
        } else {
          const session = sessionManager.createSession("json", msg.name);
          spawnWorker(session.id);

          const paths = sessionPaths(session.id);
          let attempt = 0;
          const maxRetries = 20;
          const tryConnectWorker = () => {
            attempt++;
            connectToWorker(
              session.id, paths.workerSock, sessionManager,
              workerSockets, terminalSockets, relayConnection,
            ).then((sock) => {
              if (sock) {
                socket.write(
                  serializeIpc({
                    type: "session_create_response",
                    sessionId: session.id,
                  }),
                );
                logger.info({ sessionId: session.id, mode: "json" }, "JSON session created via worker");
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
                logger.error({ sessionId: session.id }, "Worker connection timeout");
              }
            });
          };
          setTimeout(tryConnectWorker, 100);
        }
        break;
      }

      case "session_list_request": {
        const sessions = sessionManager.listSessions();
        socket.write(
          serializeIpc({
            type: "session_list_response",
            sessions: sessions.map((s) => ({
              id: s.id,
              mode: s.mode,
              state: s.state,
              createdAt: new Date(s.createdAt).toISOString(),
              ...(s.name !== undefined ? { name: s.name } : {}),
            })),
          }),
        );
        break;
      }

      case "pty_terminal_frame": {
        // terminal → serve → relay：直接转发终端帧，同时缓存用于 terminal_frame_request 回放
        lastTerminalFrames?.set(msg.sessionId, msg.frame);
        if (relayConnection) {
          relayConnection.sendRaw(msg.frame);
        } else {
          console.error("[serve] pty_terminal_frame dropped: relayConnection is null");
        }
        break;
      }

      case "pty_lines_response": {
        // terminal → serve → relay：直接转发终端行拉取响应
        if (relayConnection) {
          relayConnection.sendRaw(msg.response);
        }
        break;
      }

      case "pty_title_change": {
        // terminal → serve → relay：转发终端标题变化
        if (relayConnection) {
          relayConnection.sendRaw(JSON.stringify({
            type: "terminal_title",
            sessionId: msg.sessionId,
            title: msg.title,
          }));
        }
        break;
      }

      case "pty_resize": {
        // terminal → serve → relay：转发终端尺寸变化
        if (relayConnection) {
          relayConnection.sendRaw(JSON.stringify({
            type: "terminal_resize",
            sessionId: msg.sessionId,
            cols: msg.cols,
            rows: msg.rows,
          }));
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
        logger.info({ sessionId: msg.sessionId, success: result.success }, "Session terminated");
        break;
      }

      case "pty_register": {
        try {
          sessionManager.updateState(msg.sessionId, SessionState.IDLE);
        } catch {
          // 会话可能尚未注册，状态更新失败可忽略
        }
        sessionManager.recordHeartbeat(msg.sessionId);
        terminalSockets.set(msg.sessionId, socket);
        logger.info({ sessionId: msg.sessionId }, "PTY session registered");
        break;
      }

      case "pty_deregister": {
        sessionManager.terminateSession(msg.sessionId);
        terminalSockets.delete(msg.sessionId);
        controlHandlers?.cleanup(msg.sessionId);
        logger.info({ sessionId: msg.sessionId }, "PTY session deregistered");
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

      case "heartbeat": {
        if (msg.sessionId) {
          try {
            sessionManager.recordHeartbeat(msg.sessionId);
          } catch {
            // 心跳记录失败不影响服务正常运行
          }
        }
        socket.write(serializeIpc({ type: "heartbeat_ack" }));
        break;
      }

      case "session_status_update": {
        try {
          sessionManager.updateState(msg.sessionId, msg.state as SessionState);
        } catch (err) {
          logger.warn({ sessionId: msg.sessionId, error: String(err) }, "Failed to update session state");
        }
        break;
      }

      default: {
        logger.warn({ type: (msg as IpcMessage).type }, "Unhandled IPC message type");
      }
    }
  });

  socket.on("close", () => {
    for (const [sessionId, terminalSocket] of terminalSockets) {
      if (terminalSocket === socket) {
        const session = sessionManager.getSession(sessionId);
        if (session && session.mode === "pty" && session.state !== SessionState.TERMINATED) {
          sessionManager.terminateSession(sessionId);
          logger.info({ sessionId }, "PTY session terminated on client disconnect");
        }
        terminalSockets.delete(sessionId);
      }
    }
  });

  socket.on("error", (err) => {
    logger.warn({ error: String(err) }, "Client socket error");
  });
}

// ---------- 服务入口 ----------

export interface ServiceOptions {
  relayUrl?: string;
}

export async function startService(options?: ServiceOptions): Promise<void> {

  logger = pino(
    { level: "info" },
    pino.destination(LOG_PATH),
  );

  await cleanupStaleResources();
  try { unlinkSync(STOPPED_PATH); } catch {
    // STOPPED 文件不存在时忽略
  }

  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    onSessionRemoved: (id) => {
      const paths = sessionPaths(id);
      try { rmSync(paths.dir, { recursive: true, force: true }); } catch {
        // 会话目录清理失败不影响主流程
      }
    },
  });
  sessionManager.startReaper();

  const workerSockets = new Map<string, Socket>();
  const terminalSockets = new Map<string, Socket>();
  // 缓存每个 session 的最近一帧 terminal_frame JSON，用于 terminal_frame_request 回放
  const lastTerminalFrames = new Map<string, string>();

  // proxy 名称，优先环境变量，其次 macOS ComputerName，最后 os.hostname()
  const proxyName = process.env.CC_ANYWHERE_PROXY_NAME || getComputerName() || hostname();

  function getComputerName(): string | null {
    try {
      return execSync("scutil --get ComputerName", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim() || null;
    } catch {
      return null;
    }
  }

  // 创建 handler 模块实例（在 relay 连接建立前创建，send 函数延迟绑定）
  let relaySend: ((data: string) => void) | null = null;
  const controlHandlers = createControlMessageHandlers(
    (data) => { if (relaySend) relaySend(data); },
    sessionManager,
    logger,
  );

  // 连接中转服务器：优先用调用方传入的 relayUrl，否则从配置文件读取
  const { loadConfig } = await import("./config.js");
  const relayUrl = options?.relayUrl ?? loadConfig().relayUrl;
  let relayConnection: RelayConnection | null = null;

  if (relayUrl) {
    relayConnection = new RelayConnection(relayUrl, logger, { name: proxyName });
    relaySend = (data) => relayConnection!.sendRaw(data);
    relayConnection.connect();
    logger.info({ relayUrl, proxyName }, "Connecting to relay server");

    // 重连时 RelayConnection 自动 flush 离线队列，不需要本地回放

    // 处理来自 remote client 的消息（信封消息和控制消息）
    relayConnection.on("message", (data: string) => {
      try {
        const parsed = JSON.parse(data);

        // 信封消息：user_input, tool_approve, tool_deny
        if (parsed.type === "user_input" && parsed.sessionId) {
          const ws = workerSockets.get(parsed.sessionId);
          if (ws?.writable) {
            ws.write(serializeWorkerMsg({
              type: "worker_input",
              content: parsed.payload?.text ?? "",
            }));
          }
          logger.info({ sessionId: parsed.sessionId }, "Remote input forwarded to worker");
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
                  pending.workerSocket.write(serializeWorkerMsg({
                    type: "worker_whitelist_add",
                    toolName,
                  }));
                  logger.info({ sessionId: pending.sessionId, toolName }, "Tool added to session whitelist via relay");
                }
              }
              logger.info({ sessionId: parsed.sessionId, toolId, whitelistTool }, "Tool approved via relay");
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
              logger.info({ sessionId: parsed.sessionId, toolId }, "Tool denied via relay");
            }
          }
        }
        // 控制消息：dir_list_request, session_history_request, terminal_lines_request
        else if (parsed.type === "dir_list_request") {
          controlHandlers.handleDirListRequest({ path: parsed.path ?? "" });
        } else if (parsed.type === "session_history_request") {
          controlHandlers.handleSessionHistoryRequest();
        } else if (parsed.type === "session_list") {
          const sessions = sessionManager.listSessions();
          relaySend!(JSON.stringify({
            type: "session_list",
            sessionId: "",
            seq: 0,
            timestamp: Date.now(),
            source: "proxy",
            version: "1",
            payload: {
              sessions: sessions.map((s) => ({
                id: s.id,
                mode: s.mode,
                state: s.state,
                sessionId: s.id,
                createdAt: new Date(s.createdAt).toISOString(),
                ...(s.name !== undefined ? { name: s.name } : {}),
              })),
            },
          }));
          logger.info("Session list sent via relay");
        } else if (parsed.type === "permission_mode_change") {
          logger.info({ mode: parsed.mode }, "Permission mode change received via relay");
        } else if (parsed.type === "terminal_frame_request" && parsed.sessionId) {
          // 直接回放缓存的最近一帧，无需 IPC 往返 terminal 进程
          const cached = lastTerminalFrames.get(parsed.sessionId);
          if (cached && relaySend) {
            relaySend(cached);
            logger.info({ sessionId: parsed.sessionId }, "Replayed cached terminal frame");
          } else {
            logger.warn({ sessionId: parsed.sessionId, hasCached: !!cached }, "terminal_frame_request: no cached frame");
          }
        } else if (parsed.type === "terminal_lines_request" && parsed.sessionId) {
          // relay → serve → client IPC：转发终端行拉取请求到持有 tracker 的 client
          const targetSocket = terminalSockets.get(parsed.sessionId);
          if (targetSocket?.writable) {
            targetSocket.write(serializeIpc({
              type: "pty_lines_request",
              sessionId: parsed.sessionId,
              fromLineId: parsed.fromLineId,
              count: parsed.count,
            }));
          } else {
            logger.warn({ sessionId: parsed.sessionId }, "terminal_lines_request: no client socket for session");
          }
        }
      } catch (err) {
        logger.warn({ error: String(err) }, "Failed to parse relay message");
      }
    });

    // relay 重连时重新推送控制数据
    relayConnection.on("connected", () => {
      controlHandlers.reinitializeOnReconnect();
    });
  } else {
    logger.info("No RELAY_URL configured, relay connection disabled");
  }

  await reconnectWorkers(sessionManager, workerSockets, terminalSockets, relayConnection);

  const server = createServer((socket) => {
    handleTerminalConnection(socket, sessionManager, workerSockets, terminalSockets, relayConnection, controlHandlers, lastTerminalFrames);
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    chmodSync(SOCK_PATH, 0o600);
    logger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
  });

  // 通过事件文件 mtime 检测 PTY 会话的 idle/working 状态
  const IDLE_THRESHOLD_MS = 3000;
  const idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const session of sessionManager.listSessions()) {
      if (session.mode !== "pty") continue;
      const mtime = getEventFileMtime(session.id);
      if (mtime && now - mtime < IDLE_THRESHOLD_MS) {
        if (session.state !== SessionState.WORKING) {
          try { sessionManager.updateState(session.id, SessionState.WORKING); } catch {
            // 状态更新失败不阻断 idle 检测循环
          }
        }
      } else {
        if (session.state === SessionState.WORKING) {
          try { sessionManager.updateState(session.id, SessionState.IDLE); } catch {
            // 状态更新失败不阻断 idle 检测循环
          }
        }
      }
    }
  }, 1000);

  async function shutdown(): Promise<void> {
    logger.info("Shutting down service");
    clearInterval(idleCheckInterval);
    sessionManager.stopReaper();
    if (relayConnection) {
      relayConnection.close();
    }
    for (const [, ws] of workerSockets) {
      ws.destroy();
    }
    workerSockets.clear();
    server.close();
    try { unlinkSync(SOCK_PATH); } catch {
      // 关闭时 socket 文件可能已被删除
    }
    try { unlinkSync(PID_PATH); } catch {
      // 关闭时 PID 文件可能已被删除
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("serve.js") ||
    process.argv[1].endsWith("serve.ts"));

if (isMainModule) {
  startService();
}
