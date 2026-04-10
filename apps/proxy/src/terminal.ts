import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import { TerminalTracker } from "./terminal-tracker.js";
import { SOCK_PATH, STOPPED_PATH, LOG_PATH, sessionPaths, ensureDirectories } from "./paths.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";
import { createFramePusher, type FramePusher } from "./frame-pusher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  if (existing) return existing;

  if (!autoStart) throw new Error("Service is not running");

  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  const servePath = join(__dirname, "serve.js");
  const child = spawn(process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    const delay = Math.min(100 * (i + 1), 2000);
    await sleep(delay);
    const socket = await tryConnect(SOCK_PATH);
    if (socket) return socket;
  }

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
  let socket = await ensureService();
  let sessionId: string | null = null;
  let ptyManager: PtyManager | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let reconnecting = false;
  let tracker: TerminalTracker | null = null;
  let lastOutputTime = 0;
  let idleCheckTimer: NodeJS.Timeout | null = null;
  let framePusher: FramePusher | null = null;

  function setupHeartbeat(): void {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "heartbeat", sessionId }));
      }
    }, 10_000);
  }

  function startFramePush(): void {
    if (framePusher) framePusher.stop();
    if (!tracker || !sessionId) return;
    framePusher = createFramePusher({
      tracker,
      sessionId,
      sendFrame: (frameJson) => {
        if (socket.writable && sessionId) {
          socket.write(serializeIpc({
            type: "pty_terminal_frame",
            sessionId,
            frame: frameJson,
          }));
        }
      },
    });
    framePusher.start();
  }

  function stopFramePush(): void {
    if (framePusher) {
      framePusher.stop();
      framePusher = null;
    }
  }

  function setupSocketHandlers(): void {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === sessionId) {
        ptyManager?.write(msg.data);
      }
      if (msg.type === "pty_lines_request" && msg.sessionId === sessionId && tracker) {
        const lines = tracker.extractLines(msg.fromLineId, msg.count);
        const response = {
          type: "terminal_lines_response",
          sessionId: msg.sessionId,
          fromLineId: msg.fromLineId,
          oldestLineId: tracker.getOldestLineId(),
          newestLineId: tracker.getNewestLineId(),
          lines,
        };
        socket.write(serializeIpc({
          type: "pty_lines_response",
          sessionId: msg.sessionId,
          response: JSON.stringify(response),
        }));
      }
    });

    socket.on("close", () => {
      if (!reconnecting) {
        reconnecting = true;
        reconnectToServe();
      }
    });

    socket.on("error", () => {});
  }

  // idle/working 检测：3 秒无输出则触发快照
  function setupIdleCheck(): void {
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    idleCheckTimer = setInterval(() => {
      if (lastOutputTime > 0 && Date.now() - lastOutputTime > 3000) {
        lastOutputTime = 0;
      }
    }, 3000);
  }

  async function reconnectToServe(): Promise<void> {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      await sleep(Math.min(1000 * (i + 1), 5000));
      try {
        const stopped = existsSync(STOPPED_PATH);
        const newSocket = stopped
          ? await tryConnect(SOCK_PATH)
          : await ensureService();
        if (!newSocket) continue;
        socket = newSocket;
        reconnecting = false;

        setupSocketHandlers();

        if (sessionId) {
          socket.write(
            serializeIpc({ type: "session_create_request", mode: "pty", sessionId }),
          );
          const resp = await waitForMessage(socket, "session_create_response");
          if (resp.type === "session_create_response" && !resp.error) {
            sessionId = resp.sessionId;
            socket.write(serializeIpc({ type: "pty_register", sessionId }));
            startFramePush();
          }
        }

        setupHeartbeat();
        return;
      } catch {
        // 继续重试
      }
    }
    reconnecting = false;
  }

  // 请求创建 PTY 会话
  const responsePromise = waitForMessage(socket, "session_create_response");
  socket.write(
    serializeIpc({ type: "session_create_request", mode: "pty" }),
  );

  const response = await responsePromise;
  if (response.type !== "session_create_response") {
    throw new Error("Unexpected response type");
  }
  if (response.error) {
    throw new Error(`Failed to create session: ${response.error}`);
  }
  sessionId = response.sessionId;

  // 初始化本地事件存储和终端快照
  ensureDirectories();
  const paths = sessionPaths(sessionId);
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  tracker = new TerminalTracker(cols, rows);

  const tap: DataTap = (data: string) => {
    lastOutputTime = Date.now();
    if (tracker) {
      tracker.feed(data);
    }
  };

  setupSocketHandlers();

  ptyManager = new PtyManager({
    claudeArgs,
    tap,
    stdin: process.stdin,
    stdout: process.stdout,
    onResize: (newCols, newRows) => {
      if (tracker) tracker.resize(newCols, newRows);
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "pty_resize", sessionId, cols: newCols, rows: newRows }));
      }
    },
    onSessionExit: (code: number) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (idleCheckTimer) clearInterval(idleCheckTimer);
      stopFramePush();
      if (tracker) tracker.dispose();
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

  socket.write(serializeIpc({ type: "pty_register", sessionId }));
  startFramePush();

  setupHeartbeat();
  setupIdleCheck();

  process.on("SIGTERM", () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    stopFramePush();
    if (tracker) tracker.dispose();
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({ type: "pty_deregister", sessionId }));
    }
    ptyManager?.cleanup(143);
  });
}
