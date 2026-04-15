import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { EventStore } from "./event-store.js";
import { sessionPaths } from "./paths.js";
import { extractOscSignals, type PtySemanticState } from "./osc-extractor.js";
import { SOCK_PATH, STOPPED_PATH, LOG_PATH } from "./paths.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";
import { terminalLogger as log } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// terminal 进程生命周期状态
const TerminalState = {
  INIT: "init",
  CONNECTING_SERVICE: "connecting_service",
  CREATING_SESSION: "creating_session",
  RUNNING: "running",
  RECONNECTING: "reconnecting",
  EXITED: "exited",
} as const;
type TerminalState = (typeof TerminalState)[keyof typeof TerminalState];

function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureService(autoStart = true): Promise<Socket> {
  const existing = await tryConnect(SOCK_PATH);
  if (existing) {
    log.info("Connected to existing service");
    return existing;
  }

  if (!autoStart) throw new Error("Service is not running");

  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  const isDev = __filename.endsWith(".ts");
  const servePath = join(__dirname, isDev ? "serve.ts" : "serve.js");
  log.info({ servePath, isDev }, "Auto-starting serve daemon");
  const child = spawn(isDev ? "tsx" : process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    const delay = Math.min(100 * (i + 1), 2000);
    await sleep(delay);
    const socket = await tryConnect(SOCK_PATH);
    if (socket) {
      log.info({ attempt: i + 1 }, "Connected to service after retry");
      return socket;
    }
  }

  log.error({ maxRetries }, "Failed to connect to service");
  throw new Error(
    `Failed to connect to cc-anywhere service after ${maxRetries} retries. Check ${LOG_PATH} for details.`,
  );
}

function waitForMessage(
  socket: Socket,
  messageType: string,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, 10000);

    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === messageType) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}

export async function startTerminal(claudeArgs: string[]): Promise<void> {
  log.info("Terminal starting");
  let terminalState: TerminalState = TerminalState.INIT;
  terminalState = TerminalState.CONNECTING_SERVICE;
  let socket = await ensureService();
  let sessionId: string | null = null;
  let ptyManager: PtyManager | null = null;
  let lastOutputTime = 0;
  let idleCheckTimer: NodeJS.Timeout | null = null;
  const sessionCwd = process.env.INIT_CWD || process.cwd();
  let currentPtyState: PtySemanticState = "turn_complete";

  // D-24: headless + EventStore 在 terminal.ts 进程
  let headlessTerminal: InstanceType<typeof HeadlessTerminal> | null = null;
  let serializeAddon: SerializeAddon | null = null;
  let eventStore: EventStore | null = null;

  function sendPtyState(state: "working" | "turn_complete" | "approval_wait", title?: string, tool?: string): void {
    if (!socket.writable || !sessionId) return;
    socket.write(serializeIpc({
      type: "pty_state_push",
      sessionId,
      state,
      ...(title !== undefined ? { title } : {}),
      ...(tool !== undefined ? { tool } : {}),
    }));
    log.info({ sessionId, state, title, tool }, "PTY state pushed");
  }

  function setupSocketHandlers(): void {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === sessionId) {
        log.debug({ sessionId, bytes: msg.data.length }, "Remote input received");
        ptyManager?.write(msg.data);
      }
      // pty_frame_request 和 pty_scroll_request 不再需要处理，
      // Phase 9 binary 链路中客户端直接用 xterm.js scrollback
    });

    socket.on("close", () => {
      log.info("Serve socket closed");
      if (terminalState !== TerminalState.RECONNECTING && terminalState !== TerminalState.EXITED) {
        terminalState = TerminalState.RECONNECTING;
        reconnectToServe();
      }
    });

    socket.on("error", () => {});
  }

  // idle/working 检测：3 秒无数据输出则从 working 转为 turn_complete
  function setupIdleCheck(): void {
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    idleCheckTimer = setInterval(() => {
      if (lastOutputTime > 0 && Date.now() - lastOutputTime > 3000) {
        lastOutputTime = 0;
        if (currentPtyState === "working") {
          currentPtyState = "turn_complete";
          sendPtyState("turn_complete");
        }
      }
    }, 3000);
  }

  async function reconnectToServe(): Promise<void> {
    log.info("Serve connection lost, starting reconnection");

    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      await sleep(Math.min(1000 * (i + 1), 5000));
      try {
        const stopped = existsSync(STOPPED_PATH);
        log.debug({ attempt: i + 1, stopped }, "Reconnect attempt");
        const newSocket = stopped
          ? await tryConnect(SOCK_PATH)
          : await ensureService();
        if (!newSocket) continue;
        socket = newSocket;
        log.info({ attempt: i + 1, sessionId }, "Reconnected to serve");

        setupSocketHandlers();

        if (sessionId) {
          terminalState = TerminalState.CREATING_SESSION;
          socket.write(
            serializeIpc({ type: "session_create_request", mode: "pty", cwd: sessionCwd, name: sessionCwd.replace(process.env.HOME || "", "~"), sessionId }),
          );
          const resp = await waitForMessage(socket, "session_create_response");
          if (resp.type === "session_create_response" && !resp.error) {
            sessionId = resp.sessionId;
            socket.write(serializeIpc({ type: "pty_register", sessionId }));
            terminalState = TerminalState.RUNNING;
            log.info({ sessionId }, "Session re-registered after reconnect");
          }
        } else {
          terminalState = TerminalState.RUNNING;
        }

        return;
      } catch {
        // 继续重试
      }
    }
    log.error({ maxRetries }, "Reconnection exhausted");
  }

  // 请求创建 PTY 会话
  terminalState = TerminalState.CREATING_SESSION;
  const responsePromise = waitForMessage(socket, "session_create_response");
  socket.write(
    serializeIpc({ type: "session_create_request", mode: "pty", cwd: sessionCwd, name: sessionCwd.replace(process.env.HOME || "", "~") }),
  );

  const response = await responsePromise;
  if (response.type !== "session_create_response") {
    throw new Error("Unexpected response type");
  }
  if (response.error) {
    throw new Error(`Failed to create session: ${response.error}`);
  }
  sessionId = response.sessionId;

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  log.info({ sessionId, cols, rows }, "Session created, initializing headless terminal + EventStore");

  // D-24: headless terminal + serialize addon
  headlessTerminal = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true }); // D-19
  serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  // EventStore 初始化
  const paths = sessionPaths(sessionId);
  eventStore = new EventStore(paths.events);
  eventStore.open({ cols, rows, sessionId, createdAt: new Date().toISOString() });

  const tap: DataTap = (data: string) => {
    lastOutputTime = Date.now();

    // D-14 步骤 2: headless terminal 状态追踪
    if (headlessTerminal) {
      headlessTerminal.write(data);
    }

    // D-14 步骤 3: EventStore 立即写盘
    if (eventStore) {
      eventStore.appendPtyData(Buffer.from(data, "utf-8"));

      // D-04: 每 N 事件触发快照
      if (eventStore.shouldSnapshot() && serializeAddon) {
        const serialized = serializeAddon.serialize();
        eventStore.appendSnapshot(serialized);
      }
    }

    // D-14 步骤 4: JSON IPC 帧推送到 serve（临时保留，Plan 02 替换为 binary IPC）
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({
        type: "pty_terminal_frame",
        sessionId,
        frame: JSON.stringify({
          type: "terminal_frame",
          sessionId,
          payload: { mode: "full", lines: [] },
        }),
      }));
    }

    // 有数据输出即为 working
    if (currentPtyState !== "working") {
      currentPtyState = "working";
      sendPtyState("working");
    }

    // OSC 信号检测 approval_wait
    const signal = extractOscSignals(data);
    if (signal?.state === "approval_wait") {
      currentPtyState = "approval_wait";
      sendPtyState("approval_wait", signal.title, signal.tool);
    }
  };

  setupSocketHandlers();

  ptyManager = new PtyManager({
    claudeArgs,
    tap,
    stdin: process.stdin,
    stdout: process.stdout,
    onResize: (newCols, newRows) => {
      if (headlessTerminal) headlessTerminal.resize(newCols, newRows);
      if (eventStore) eventStore.appendResize(newCols, newRows);
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "pty_resize", sessionId, cols: newCols, rows: newRows }));
      }
    },
    onSessionExit: async (code: number) => {
      terminalState = TerminalState.EXITED;
      log.info({ sessionId, exitCode: code }, "PTY exited, cleaning up");
      if (idleCheckTimer) clearInterval(idleCheckTimer);
      // D-03: 会话结束时归档 EventStore
      if (eventStore) {
        await eventStore.close();
        eventStore = null;
      }
      if (headlessTerminal) {
        headlessTerminal.dispose();
        headlessTerminal = null;
      }
      serializeAddon = null;
      if (socket.writable && sessionId) {
        socket.write(
          serializeIpc({ type: "pty_deregister", sessionId }),
        );
      }
      socket.end();
      process.exit(code);
    },
  });
  ptyManager.start();
  log.info({ sessionId }, "PTY started with headless terminal + EventStore");

  socket.write(serializeIpc({ type: "pty_register", sessionId }));
  terminalState = TerminalState.RUNNING;

  setupIdleCheck();

  process.on("SIGTERM", async () => {
    log.info({ sessionId }, "SIGTERM received, shutting down");
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    if (eventStore) {
      await eventStore.close();
      eventStore = null;
    }
    if (headlessTerminal) {
      headlessTerminal.dispose();
      headlessTerminal = null;
    }
    serializeAddon = null;
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({ type: "pty_deregister", sessionId }));
    }
    ptyManager?.cleanup(143);
  });
}
