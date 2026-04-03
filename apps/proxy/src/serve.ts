import { createServer, connect, type Socket } from "node:net";
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import pino from "pino";
import { SessionState } from "@cc-anywhere/shared";
import { SessionManager } from "./session-manager.js";
import { JsonSession } from "./json-session.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";

const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
const SOCK_PATH = `${CC_DIR}/cc-anywhere.sock`;
const PID_PATH = `${CC_DIR}/cc-anywhere.pid`;
const PERSIST_PATH = `${CC_DIR}/sessions.json`;
const LOG_PATH = `${CC_DIR}/service.log`;

function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

// 检查指定 PID 的进程是否存活
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 检查并清理过期的 socket 和 PID 文件
async function cleanupStaleResources(
  logger: pino.Logger,
): Promise<void> {
  if (existsSync(SOCK_PATH)) {
    const existing = await tryConnect(SOCK_PATH);
    if (existing) {
      existing.destroy();
      logger.error("Another service is already running on %s", SOCK_PATH);
      process.exit(1);
    }
    unlinkSync(SOCK_PATH);
    logger.info("Removed stale socket file");
  }

  if (existsSync(PID_PATH)) {
    const pidStr = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      logger.error("Another service is already running with PID %d", pid);
      process.exit(1);
    }
    unlinkSync(PID_PATH);
    logger.info("Removed stale PID file");
  }
}

// 处理单个客户端连接上的所有 IPC 消息
function handleClientConnection(
  socket: Socket,
  sessionManager: SessionManager,
  jsonSessions: Map<string, JsonSession>,
  clientSockets: Map<string, Socket>,
  logger: pino.Logger,
): void {
  createIpcReader(socket, (msg: IpcMessage) => {
    switch (msg.type) {
      case "session_create_request": {
        if (msg.mode === "pty") {
          const session = sessionManager.createSession("pty", msg.name);
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
            }),
          );
          logger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
        } else {
          const session = sessionManager.createSession("json", msg.name);
          const jsonSession = new JsonSession({
            onEvent: (event) => {
              // 广播事件给所有连接的客户端
              for (const [, clientSocket] of clientSockets) {
                if (clientSocket.writable) {
                  clientSocket.write(
                    serializeIpc({
                      type: "session_status_update",
                      sessionId: session.id,
                      state: SessionState.WORKING,
                    }),
                  );
                }
              }
              logger.debug({ sessionId: session.id, eventType: event.type }, "JSON session event");
            },
            onExit: (code) => {
              sessionManager.terminateSession(session.id);
              jsonSessions.delete(session.id);
              logger.info({ sessionId: session.id, exitCode: code }, "JSON session exited");
            },
          });
          const pid = jsonSession.start();
          sessionManager.setPid(session.id, pid);
          jsonSessions.set(session.id, jsonSession);
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
            }),
          );
          logger.info({ sessionId: session.id, mode: "json", pid }, "JSON session created");
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

      case "session_terminate_request": {
        const result = sessionManager.terminateSession(msg.sessionId);
        const js = jsonSessions.get(msg.sessionId);
        if (js) {
          js.stop();
          jsonSessions.delete(msg.sessionId);
        }
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
          // 会话可能已被清理
        }
        sessionManager.recordHeartbeat(msg.sessionId);
        clientSockets.set(msg.sessionId, socket);
        logger.info({ sessionId: msg.sessionId }, "PTY session registered");
        break;
      }

      case "pty_deregister": {
        sessionManager.terminateSession(msg.sessionId);
        clientSockets.delete(msg.sessionId);
        logger.info({ sessionId: msg.sessionId }, "PTY session deregistered");
        break;
      }

      case "pty_output": {
        // Phase 4 将转发到 relay 服务器
        logger.debug({ sessionId: msg.sessionId, dataLen: msg.data.length }, "PTY output received");
        break;
      }

      case "pty_input": {
        // 将输入转发给拥有此会话的客户端 socket
        const targetSocket = clientSockets.get(msg.sessionId);
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
            // 会话可能已被清理
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
    // 客户端断开连接，清理其拥有的 PTY 会话
    for (const [sessionId, clientSocket] of clientSockets) {
      if (clientSocket === socket) {
        const session = sessionManager.getSession(sessionId);
        if (session && session.mode === "pty" && session.state !== SessionState.TERMINATED) {
          sessionManager.terminateSession(sessionId);
          logger.info({ sessionId }, "PTY session terminated on client disconnect");
        }
        clientSockets.delete(sessionId);
      }
    }
  });

  socket.on("error", (err) => {
    logger.warn({ error: String(err) }, "Client socket error");
  });
}

export async function startService(): Promise<void> {
  mkdirSync(CC_DIR, { recursive: true });

  const logger = pino(
    { level: "info" },
    pino.destination(LOG_PATH),
  );

  await cleanupStaleResources(logger);

  const sessionManager = new SessionManager({ persistPath: PERSIST_PATH });
  sessionManager.startReaper();

  const jsonSessions = new Map<string, JsonSession>();
  const clientSockets = new Map<string, Socket>();

  const server = createServer((socket) => {
    handleClientConnection(socket, sessionManager, jsonSessions, clientSockets, logger);
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    chmodSync(SOCK_PATH, 0o600);
    logger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
  });

  async function shutdown(): Promise<void> {
    logger.info("Shutting down service");
    sessionManager.stopReaper();
    sessionManager.terminateAll();
    for (const [, js] of jsonSessions) {
      await js.stop();
    }
    jsonSessions.clear();
    server.close();
    try {
      unlinkSync(SOCK_PATH);
    } catch {
      // socket 文件可能已不存在
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // PID 文件可能已不存在
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

// 支持直接运行此文件启动服务
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("serve.js") ||
    process.argv[1].endsWith("serve.ts"));

if (isMainModule) {
  startService();
}
