import { createServer, connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { SessionState, buildMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "./common/logger.js";
import { SessionManager, type SessionInfo } from "./serve/session-manager.js";
import { RelayConnection } from "./serve/relay-connection.js";
import { SOCK_PATH, PID_PATH, STOPPED_PATH, SESSIONS_PATH, sessionPaths } from "./common/paths.js";
import { loadConfig } from "./common/config.js";
import { createIpcReader, serializeIpc, type IpcMessage } from "./ipc/ipc-protocol.js";
import {
  createControlMessageHandlers,
  type ControlMessageHandlers,
} from "./serve/handlers/control-messages.js";
import { ToolApprovalManager } from "./serve/tool-approval-manager.js";
import { WorkerRegistry } from "./serve/worker-registry.js";
import { RelayRouter } from "./serve/relay-router.js";
import { PtyObserver } from "./serve/pty-observer.js";
import { JsonObserver } from "./serve/json-observer.js";
import { HookRegistry } from "./serve/hook-registry.js";
import { HookServer } from "./serve/hook-server.js";
import { PermissionBroker } from "./serve/permission-broker.js";
import { HookEventRouter } from "./serve/hook-event-router.js";
import type { ProviderHookContext } from "./providers/index.js";

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
  relay: RelayConnection,
  sessionManager: SessionManager,
  sessionId: string,
): void {
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
function broadcastSessionList(relay: RelayConnection, sessionManager: SessionManager): void {
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
function broadcastSessionSync(relay: RelayConnection, session: SessionInfo): void {
  relay.sendRaw(
    JSON.stringify({
      type: "session_sync",
      sessions: [{ id: session.id, mode: session.mode, state: session.state }],
    }),
  );
}

// 状态迁移 + 推 envelope 的一体化入口。
// same-state / 非法转换的降级和日志分级由 SessionManager.updateState 负责；这里只在真正发生了转换时才广播 status。
function changeSessionState(
  sessionManager: SessionManager,
  relay: RelayConnection,
  sessionId: string,
  next: SessionState,
): boolean {
  if (!sessionManager.getSession(sessionId)) return false;
  const changed = sessionManager.updateState(sessionId, next);
  if (changed) pushSessionStatus(relay, sessionManager, sessionId);
  return changed;
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
  relayConnection: RelayConnection,
  controlHandlers: ControlMessageHandlers,
  ptyObserver: PtyObserver,
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext,
): void {
  createIpcReader(
    socket,
    (msg: IpcMessage) => {
      switch (msg.type) {
        case "session_create_request": {
          // IPC 入口只接 PTY 创建；JSON session 由 relay 远程客户端驱动
          if (msg.mode !== "pty") {
            socket.write(
              serializeIpc({
                type: "session_create_response",
                sessionId: "",
                error: `Unsupported mode via IPC: ${msg.mode}`,
              }),
            );
            break;
          }
          const existing = msg.sessionId ? sessionManager.getSession(msg.sessionId) : undefined;
          const session =
            existing ??
            sessionManager.createSession("pty", msg.cwd, msg.pid, msg.name, msg.sessionId);
          if (existing) {
            ptyObserver.onTerminalAttached(session.id);
            sessionManager.setPid(session.id, msg.pid);
          }
          socket.write(
            serializeIpc({
              type: "session_create_response",
              sessionId: session.id,
              hook: createHookContext(session.id, "claude"),
            }),
          );
          serviceLogger.info({ sessionId: session.id, mode: "pty" }, "PTY session created");
          break;
        }

        case "service_status_request": {
          const relayStatus = relayConnection.getStatus();
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
          relayConnection.sendRaw(
            JSON.stringify({
              type: "terminal_title",
              sessionId: msg.sessionId,
              title: msg.title,
            }),
          );
          break;
        }

        case "pty_state_push": {
          // terminal → serve → relay：PTY 语义状态变化；PtyObserver 负责 OSC 信号 → SessionState 映射
          ptyObserver.onPtySignal(msg.sessionId, msg.state);
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
          break;
        }

        case "pty_resize": {
          // terminal → serve → relay：转发终端尺寸变化
          relayConnection.sendRaw(
            JSON.stringify({
              type: "terminal_resize",
              sessionId: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
            }),
          );
          break;
        }

        case "session_terminate_request": {
          const result = sessionManager.terminateSession(msg.sessionId);
          workerRegistry.send(msg.sessionId, { type: "worker_stop" });
          workerRegistry.delete(msg.sessionId);

          controlHandlers.cleanup(msg.sessionId);
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
          ptyObserver.onTerminalAttached(msg.sessionId);
          sessionManager.setPid(msg.sessionId, msg.pid);
          terminalSockets.set(msg.sessionId, socket);
          // 注册即告知当前 bridge 状态，避免新接入的终端要等下次状态翻转才知道
          socket.write(
            serializeIpc({
              type: "bridge_status",
              connected: relayConnection.getStatus().connected,
            }),
          );
          // 通知 relay 该 session 存在，并推送会话列表给客户端
          const session = sessionManager.getSession(msg.sessionId);
          if (session) {
            broadcastSessionSync(relayConnection, session);
          }
          broadcastSessionList(relayConnection, sessionManager);
          serviceLogger.info({ sessionId: msg.sessionId }, "PTY session registered");
          break;
        }

        case "pty_deregister": {
          // 先通知客户端状态变更，再清理 session
          relayConnection.sendRaw(
            JSON.stringify({
              type: "pty_state",
              sessionId: msg.sessionId,
              payload: { state: "turn_complete" },
            }),
          );
          sessionManager.terminateSession(msg.sessionId);
          terminalSockets.delete(msg.sessionId);

          controlHandlers.cleanup(msg.sessionId);
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
          break;
        }

        default: {
          serviceLogger.warn({ type: (msg as IpcMessage).type }, "Unhandled IPC message type");
        }
      }
    },
    (sessionId, data) => {
      // WebSocket binary 帧格式: [1B sessionId_len][sessionId UTF-8][PTY data]
      const sessionIdBuf = Buffer.from(sessionId, "utf-8");
      const wsFrame = Buffer.alloc(1 + sessionIdBuf.length + data.length);
      wsFrame[0] = sessionIdBuf.length;
      sessionIdBuf.copy(wsFrame, 1);
      data.copy(wsFrame, 1 + sessionIdBuf.length);
      relayConnection.sendBinary(wsFrame);
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
        relayConnection.sendRaw(
          JSON.stringify({
            type: "pty_state",
            sessionId,
            payload: { state: "turn_complete" },
          }),
        );
        sessionManager.terminateSession(sessionId);
        controlHandlers.cleanup(sessionId);
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

  const hookRegistry = new HookRegistry();
  const permissionBroker = new PermissionBroker();
  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    onSessionRemoved: (id) => {
      hookRegistry.unregisterSession(id);
      permissionBroker.cleanupSession(id, "session removed");
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
  const proxyName = process.env.DEV_ANYWHERE_PROXY_NAME || getComputerName() || hostname();

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

  // 连接中转服务器：优先用调用方传入的 relayUrl，否则从配置文件读取
  // relay 是 proxy 存在的必要前提，未配置直接 fail-fast，不再支持"本地独立"模式
  const proxyConfig = loadConfig();
  const relayUrl = options?.relayUrl ?? proxyConfig.relayUrl;
  const relayToken = proxyConfig.relayToken;
  if (!relayUrl) {
    const msg =
      'RELAY_URL is required. Set it via $RELAY_URL or ~/.dev-anywhere/config.json {"relayUrl": "ws://..."}';
    serviceLogger.error(msg);
    console.error(msg);
    process.exit(1);
  }
  const relayConnection = new RelayConnection(relayUrl, { name: proxyName, token: relayToken });
  const relaySend = (data: string): void => relayConnection.sendRaw(data);
  const controlHandlers = createControlMessageHandlers(relaySend, sessionManager);

  // 两个观察通道共用同一个底层 changeSessionState 原语；由 FSM 按 session.mode 路由到对应转换表
  const observerChangeState = (sessionId: string, next: SessionState): boolean =>
    changeSessionState(sessionManager, relayConnection, sessionId, next);
  const ptyObserver = new PtyObserver({ changeSessionState: observerChangeState });
  const jsonObserver = new JsonObserver({ changeSessionState: observerChangeState });
  const hookEventRouter = new HookEventRouter({
    relayConnection,
    changeSessionState: observerChangeState,
  });
  const hookServer = new HookServer({
    port: proxyConfig.hookPort ?? 17654,
    registry: hookRegistry,
    permissionBroker,
    onEvent: (event) => {
      serviceLogger.info(
        {
          sessionId: event.sessionId,
          provider: event.provider,
          event: event.event,
          requestId: event.requestId,
        },
        "Provider hook event received",
      );
      hookEventRouter.handle(event);
    },
  });

  try {
    await hookServer.start();
  } catch (err) {
    const msg = `Failed to start hook server on 127.0.0.1:${proxyConfig.hookPort ?? 17654}: ${String(err)}`;
    serviceLogger.error(msg);
    console.error(msg);
    process.exit(1);
  }
  const hookUrl = `http://127.0.0.1:${hookServer.getListeningPort() ?? proxyConfig.hookPort ?? 17654}/hook`;
  const createHookContext = (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ): ProviderHookContext => {
    const credentials = hookRegistry.registerSession(sessionId, provider);
    return {
      provider,
      sessionId,
      hookUrl,
      marker: credentials.marker,
      token: credentials.token,
    };
  };

  // WorkerRegistry 建在 relay 之后、listener 之前；构造期订阅 envelope_dropped 事件
  const workerRegistry = new WorkerRegistry({
    sessionManager,
    toolApprovalManager,
    relayConnection,
    jsonObserver,
  });

  relayConnection.connect();
  serviceLogger.info({ relayUrl, proxyName, tokenSet: !!relayToken }, "Connecting to relay server");

  const relayRouter = new RelayRouter({
    sessionManager,
    workerRegistry,
    toolApprovalManager,
    controlHandlers,
    relayConnection,
    relaySend,
    terminalSockets,
    broadcastSessionList: () => broadcastSessionList(relayConnection, sessionManager),
    broadcastSessionSync: (session) => broadcastSessionSync(relayConnection, session),
    jsonObserver,
    createHookContext,
    permissionBroker,
    hookEventRouter,
  });

  relayConnection.on("message", (msg: Record<string, unknown>) => relayRouter.handle(msg));
  relayConnection.on("connected", () => {
    controlHandlers.reinitializeOnReconnect();
    broadcastBridgeStatus(true);
  });
  relayConnection.on("disconnected", () => {
    broadcastBridgeStatus(false);
  });

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
      ptyObserver,
      createHookContext,
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
    await hookServer.close();
    relayConnection.close();
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
