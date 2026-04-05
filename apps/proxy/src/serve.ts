import { createServer, connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import pino from "pino";
import { SessionState } from "@cc-anywhere/shared";
import { SessionManager } from "./session-manager.js";
import { EventStore, EventType } from "./event-store.js";
import { TerminalTracker } from "./terminal-tracker.js";
import {
  SOCK_PATH,
  PID_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  LASTSEQ_PATH,
  LOG_PATH,
  DATA_DIR,
  ensureDirectories,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let logger: pino.Logger;

// 每个会话的 EventStore 和 TerminalTracker 实例
const eventStores = new Map<string, EventStore>();
const trackers = new Map<string, TerminalTracker>();

// serve 侧记录的每个会话最后处理的 seq
const lastSeqMap = new Map<string, number>();

// PTY 会话最后一次输出的时间戳
const lastOutputTime = new Map<string, number>();

// ---------- EventStore 管理 ----------

function getOrCreateStore(sessionId: string): EventStore {
  let store = eventStores.get(sessionId);
  if (!store) {
    store = new EventStore(sessionId);
    eventStores.set(sessionId, store);
  }
  if (!trackers.has(sessionId)) {
    trackers.set(sessionId, new TerminalTracker(store, sessionPaths(sessionId).snapshot));
  }
  return store;
}

function removeStore(sessionId: string): void {
  const store = eventStores.get(sessionId);
  if (store) {
    store.cleanup();
    eventStores.delete(sessionId);
  }
  const tracker = trackers.get(sessionId);
  if (tracker) {
    tracker.dispose();
    trackers.delete(sessionId);
  }
  lastSeqMap.delete(sessionId);
  lastOutputTime.delete(sessionId);
  const paths = sessionPaths(sessionId);
  try { rmSync(paths.dir, { recursive: true, force: true }); } catch {}
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

// ---------- Worker 管理 ----------

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
            const store = getOrCreateStore(sessionId);
            const eventData = JSON.stringify(msg.event);
            store.append(EventType.PTY_OUTPUT, eventData);
            const seq = store.getSeq();
            lastSeqMap.set(sessionId, seq);
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
            logger.debug({ sessionId, seq, eventType: msg.event.type }, "JSON session event");
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
  clientSockets: Map<string, Socket>,
): Promise<void> {
  if (!existsSync(DATA_DIR)) return;

  const dirs = readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const sessionId = dir.name;
    const paths = sessionPaths(sessionId);
    if (!existsSync(paths.workerSock)) continue;

    const sock = await connectToWorker(
      sessionId, paths.workerSock, sessionManager, workerSockets, clientSockets, true,
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
      try { unlinkSync(paths.workerSock); } catch {}
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
          const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
          const session = existing ?? sessionManager.createSession("pty", msg.name, msg.sessionId);
          if (existing) {
            try { sessionManager.updateState(session.id, SessionState.IDLE); } catch {}
          }
          getOrCreateStore(session.id);
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
            }),
          );
          logger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
        } else {
          const session = sessionManager.createSession("json", msg.name);
          getOrCreateStore(session.id);
          spawnWorker(session.id);

          const paths = sessionPaths(session.id);
          let attempt = 0;
          const maxRetries = 20;
          const tryConnectWorker = () => {
            attempt++;
            connectToWorker(
              session.id, paths.workerSock, sessionManager,
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
        const store = getOrCreateStore(msg.sessionId);
        store.append(EventType.PTY_OUTPUT, msg.data);

        // 喂数据给虚拟终端，检查是否需要事件阈值快照
        const tracker = trackers.get(msg.sessionId);
        if (tracker) {
          tracker.feed(msg.data);
          if (tracker.shouldSnapshot()) {
            tracker.takeSnapshot();
          }
        }

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
  ensureDirectories();

  logger = pino(
    { level: "info" },
    pino.destination(LOG_PATH),
  );

  await cleanupStaleResources();
  try { unlinkSync(STOPPED_PATH); } catch {}
  loadLastSeqMap();

  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    onSessionRemoved: (id) => {
      removeStore(id);
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

  const seqPersistInterval = setInterval(() => {
    saveLastSeqMap();
  }, 10_000);

  const IDLE_THRESHOLD_MS = 3000;
  const idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastTime] of lastOutputTime) {
      if (now - lastTime > IDLE_THRESHOLD_MS) {
        const session = sessionManager.getSession(sessionId);
        if (session && session.state === SessionState.WORKING) {
          try { sessionManager.updateState(sessionId, SessionState.IDLE); } catch {}
          // working→idle 触发终端快照
          const tracker = trackers.get(sessionId);
          if (tracker) {
            const store = eventStores.get(sessionId);
            if (store) store.flush();
            tracker.onStateChange("working", "idle");
          }
        }
        lastOutputTime.delete(sessionId);
      }
    }
  }, 3000);

  async function shutdown(): Promise<void> {
    logger.info("Shutting down service");
    clearInterval(seqPersistInterval);
    clearInterval(idleCheckInterval);
    // flush 所有 EventStore
    for (const [, store] of eventStores) {
      store.close();
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
