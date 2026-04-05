import { createServer, connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import pino from "pino";
import { SessionState } from "@cc-anywhere/shared";
import { SessionManager } from "./session-manager.js";
import {
  createIpcReader,
  serializeIpc,
  createWorkerReader,
  serializeWorkerMsg,
  type IpcMessage,
  type WorkerMessage,
} from "./ipc-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
const SOCK_PATH = `${CC_DIR}/cc-anywhere.sock`;
const PID_PATH = `${CC_DIR}/cc-anywhere.pid`;
const PERSIST_PATH = `${CC_DIR}/sessions.json`;
const LOG_PATH = `${CC_DIR}/service.log`;
const WORKERS_DIR = `${CC_DIR}/sessions`;
const EVENTS_DIR = `${CC_DIR}/events`;
const LASTSEQ_PATH = `${CC_DIR}/lastseq.json`;
const STOPPED_PATH = `${CC_DIR}/stopped`;

// 模块级 logger，在 startService 中初始化
let logger: pino.Logger;

// 每个会话的事件序列号计数器
const seqCounters = new Map<string, number>();

// serve 侧记录的每个会话最后处理的 seq，用于重连回放
const lastSeqMap = new Map<string, number>();

// PTY 输出缓冲区，200ms 窗口内合并写入
interface OutputBuffer {
  chunks: string[];
  timer: NodeJS.Timeout;
}
const outputBuffers = new Map<string, OutputBuffer>();

function flushOutputBuffer(sessionId: string, sessionManager: SessionManager): void {
  const buf = outputBuffers.get(sessionId);
  if (!buf) return;
  outputBuffers.delete(sessionId);

  const data = buf.chunks.join("");
  const eventSeq = appendEvent(sessionId, { type: "pty_output", data });
  lastSeqMap.set(sessionId, eventSeq);
}

// PTY 会话最后一次输出的时间戳，用于 idle 检测
const lastOutputTime = new Map<string, number>();

// ---------- 事件日志 ----------

function initSeqCounter(sessionId: string): void {
  const eventsPath = `${EVENTS_DIR}/${sessionId}.jsonl`;
  if (existsSync(eventsPath)) {
    const content = readFileSync(eventsPath, "utf-8").trim();
    if (content.length > 0) {
      const lines = content.split("\n");
      const lastLine = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(lastLine);
        if (typeof parsed.seq === "number") {
          seqCounters.set(sessionId, parsed.seq);
          return;
        }
      } catch {}
    }
  }
  seqCounters.set(sessionId, 0);
}

function appendEvent(sessionId: string, event: Record<string, unknown>): number {
  const current = seqCounters.get(sessionId) ?? 0;
  const nextSeq = current + 1;
  seqCounters.set(sessionId, nextSeq);

  const entry = { seq: nextSeq, ts: Date.now(), sessionId, ...event };
  appendFileSync(`${EVENTS_DIR}/${sessionId}.jsonl`, JSON.stringify(entry) + "\n");
  return nextSeq;
}

function replayEvents(sessionId: string, afterSeq: number): Array<Record<string, unknown>> {
  const eventsPath = `${EVENTS_DIR}/${sessionId}.jsonl`;
  if (!existsSync(eventsPath)) return [];

  const content = readFileSync(eventsPath, "utf-8").trim();
  if (content.length === 0) return [];

  const events: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.seq === "number" && entry.seq > afterSeq) {
        events.push(entry);
      }
    } catch {}
  }
  return events;
}

// ---------- lastSeq 持久化 ----------

function saveLastSeqMap(): void {
  const data: Record<string, number> = {};
  for (const [id, seq] of lastSeqMap) {
    data[id] = seq;
  }
  writeFileSync(LASTSEQ_PATH, JSON.stringify(data));
}

function loadLastSeqMap(): void {
  if (!existsSync(LASTSEQ_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(LASTSEQ_PATH, "utf-8"));
    for (const [id, seq] of Object.entries(data)) {
      if (typeof seq === "number") {
        lastSeqMap.set(id, seq);
      }
    }
  } catch {}
}

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

// ---------- Worker 管理（JSON 会话补充能力） ----------

function connectToWorker(
  sessionId: string,
  sockPath: string,
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  clientSockets: Map<string, Socket>,
  replay: boolean,
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
          case "worker_event": {
            // worker 事件写入 serve 侧事件日志
            const eventSeq = appendEvent(sessionId, msg.event);
            lastSeqMap.set(sessionId, eventSeq);
            // 广播给所有连接的客户端
            for (const [, clientSocket] of clientSockets) {
              if (clientSocket.writable) {
                clientSocket.write(
                  serializeIpc({
                    type: "session_status_update",
                    sessionId,
                    state: SessionState.WORKING,
                  }),
                );
              }
            }
            logger.debug({ sessionId, seq: eventSeq, eventType: msg.event.type }, "JSON session event");
            break;
          }
          case "worker_replay_done":
            logger.info({ sessionId, replayedCount: msg.replayedCount }, "Worker event replay complete");
            break;
          case "worker_exit":
            sessionManager.terminateSession(sessionId);
            workerSockets.delete(sessionId);
            logger.info({ sessionId, exitCode: msg.code }, "JSON session exited");
            break;
          case "worker_approval_request":
            logger.info({ sessionId, toolName: msg.toolName }, "Tool approval requested (auto-deny)");
            sock.write(serializeWorkerMsg({
              type: "worker_approval_response",
              requestId: msg.requestId,
              behavior: "deny",
              message: "Remote approval not yet configured.",
            }));
            break;
        }
      });

      if (replay) {
        const lastSeq = lastSeqMap.get(sessionId) ?? 0;
        sock.write(serializeWorkerMsg({ type: "worker_replay", lastSeq }));
      }

      sock.on("close", () => { workerSockets.delete(sessionId); });
      sock.on("error", () => { workerSockets.delete(sessionId); });

      resolve(sock);
    });
    sock.on("error", () => resolve(null));
  });
}

function spawnWorker(sessionId: string): void {
  const workerPath = join(__dirname, "session-worker.js");
  const workerSockPath = `${WORKERS_DIR}/${sessionId}.sock`;

  const child = spawn(process.execPath, [workerPath, sessionId, workerSockPath, "--"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logger.info({ sessionId, workerPid: child.pid }, "Worker process spawned");
}

async function reconnectWorkers(
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  clientSockets: Map<string, Socket>,
): Promise<void> {
  if (!existsSync(WORKERS_DIR)) return;

  const files = readdirSync(WORKERS_DIR).filter((f) => f.endsWith(".sock"));
  for (const file of files) {
    const sessionId = file.replace(".sock", "");
    const sockPath = `${WORKERS_DIR}/${file}`;
    initSeqCounter(sessionId);
    const sock = await connectToWorker(
      sessionId, sockPath, sessionManager, workerSockets, clientSockets, true,
    );
    if (sock) {
      if (!sessionManager.getSession(sessionId)) {
        sessionManager.createSession("json", undefined, sessionId);
      }
      try {
        sessionManager.updateState(sessionId, SessionState.IDLE);
      } catch {}
      logger.info({ sessionId }, "Reconnected to existing worker");
    } else {
      try { unlinkSync(sockPath); } catch {}
      logger.info({ sessionId }, "Cleaned up stale worker socket");
    }
  }
}

// ---------- 客户端 IPC 消息处理 ----------

function handleClientConnection(
  socket: Socket,
  sessionManager: SessionManager,
  workerSockets: Map<string, Socket>,
  clientSockets: Map<string, Socket>,
): void {
  createIpcReader(socket, (msg: IpcMessage) => {
    switch (msg.type) {
      case "session_create_request": {
        if (msg.mode === "pty") {
          // 重连时复用已有 session，否则创建新的
          const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
          const session = existing ?? sessionManager.createSession("pty", msg.name, msg.sessionId);
          if (existing) {
            // 重置状态为 IDLE（可能之前被标记为 terminated）
            try { sessionManager.updateState(session.id, SessionState.IDLE); } catch {}
          }
          initSeqCounter(session.id);
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
            }),
          );
          logger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
        } else {
          const session = sessionManager.createSession("json", msg.name);
          initSeqCounter(session.id);
          spawnWorker(session.id);

          const workerSockPath = `${WORKERS_DIR}/${session.id}.sock`;
          let attempt = 0;
          const maxRetries = 20;
          const tryConnectWorker = () => {
            attempt++;
            connectToWorker(
              session.id, workerSockPath, sessionManager,
              workerSockets, clientSockets, false,
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

      case "session_terminate_request": {
        const result = sessionManager.terminateSession(msg.sessionId);
        const ws = workerSockets.get(msg.sessionId);
        if (ws?.writable) {
          ws.write(serializeWorkerMsg({ type: "worker_stop" }));
        }
        workerSockets.delete(msg.sessionId);
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
        } catch {}
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
        // 缓冲合并 PTY 输出，200ms 窗口内的数据合成一条事件
        const buf = outputBuffers.get(msg.sessionId);
        if (buf) {
          buf.chunks.push(msg.data);
        } else {
          outputBuffers.set(msg.sessionId, {
            chunks: [msg.data],
            timer: setTimeout(() => {
              flushOutputBuffer(msg.sessionId, sessionManager);
            }, 200),
          });
        }

        // 记录最后输出时间，状态检查器会据此判断 idle/working
        lastOutputTime.set(msg.sessionId, Date.now());
        const session = sessionManager.getSession(msg.sessionId);
        if (session && session.state !== SessionState.WORKING) {
          try { sessionManager.updateState(msg.sessionId, SessionState.WORKING); } catch {}
        }
        break;
      }

      case "pty_input": {
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
          } catch {}
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

// ---------- 服务入口 ----------

export async function startService(): Promise<void> {
  mkdirSync(CC_DIR, { recursive: true });
  mkdirSync(EVENTS_DIR, { recursive: true });

  logger = pino(
    { level: "info" },
    pino.destination(LOG_PATH),
  );

  await cleanupStaleResources();
  try { unlinkSync(STOPPED_PATH); } catch {}
  loadLastSeqMap();

  const sessionManager = new SessionManager({
    persistPath: PERSIST_PATH,
    onSessionRemoved: (id) => {
      // 清理事件日志和 seq 状态
      const eventsPath = `${EVENTS_DIR}/${id}.jsonl`;
      try { unlinkSync(eventsPath); } catch {}
      seqCounters.delete(id);
      lastSeqMap.delete(id);
    },
  });
  sessionManager.startReaper();

  const workerSockets = new Map<string, Socket>();
  const clientSockets = new Map<string, Socket>();

  await reconnectWorkers(sessionManager, workerSockets, clientSockets);

  const server = createServer((socket) => {
    handleClientConnection(socket, sessionManager, workerSockets, clientSockets);
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    chmodSync(SOCK_PATH, 0o600);
    logger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
  });

  // 定期持久化 lastSeqMap
  const seqPersistInterval = setInterval(() => {
    saveLastSeqMap();
  }, 10_000);

  // 定期检查 PTY 会话是否应该回到 idle（3 秒无输出）
  const IDLE_THRESHOLD_MS = 3000;
  const idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastTime] of lastOutputTime) {
      if (now - lastTime > IDLE_THRESHOLD_MS) {
        const session = sessionManager.getSession(sessionId);
        if (session && session.state === SessionState.WORKING) {
          try { sessionManager.updateState(sessionId, SessionState.IDLE); } catch {}
        }
        lastOutputTime.delete(sessionId);
      }
    }
  }, 3000);

  async function shutdown(): Promise<void> {
    logger.info("Shutting down service");
    clearInterval(seqPersistInterval);
    clearInterval(idleCheckInterval);
    // flush 残留的输出缓冲区
    for (const [sid] of outputBuffers) {
      flushOutputBuffer(sid, sessionManager);
    }
    saveLastSeqMap();
    sessionManager.stopReaper();
    for (const [, ws] of workerSockets) {
      ws.destroy();
    }
    workerSockets.clear();
    server.close();
    try { unlinkSync(SOCK_PATH); } catch {}
    try { unlinkSync(PID_PATH); } catch {}
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
