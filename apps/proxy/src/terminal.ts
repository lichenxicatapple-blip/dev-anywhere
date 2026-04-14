import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import { TerminalTracker } from "./terminal-tracker.js";
import { extractOscSignals, type PtySemanticState } from "./osc-extractor.js";
import { SOCK_PATH, STOPPED_PATH, LOG_PATH } from "./paths.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";
import { createFramePusher, type FramePusher } from "./frame-pusher.js";
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
  let tracker: TerminalTracker | null = null;
  let lastOutputTime = 0;
  let idleCheckTimer: NodeJS.Timeout | null = null;
  const sessionCwd = process.env.INIT_CWD || process.cwd();
  let framePusher: FramePusher | null = null;
  let currentPtyState: PtySemanticState = "turn_complete";

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
    log.debug({ sessionId }, "Frame push started");
  }

  function stopFramePush(): void {
    if (framePusher) {
      framePusher.stop();
      framePusher = null;
      log.debug("Frame push stopped");
    }
  }

  function setupSocketHandlers(): void {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === sessionId) {
        log.debug({ sessionId, bytes: msg.data.length }, "Remote input received");
        ptyManager?.write(msg.data);
      }
      if (msg.type === "pty_frame_request" && msg.sessionId === sessionId && tracker && framePusher) {
        if (msg.rows) tracker.setClientRows(msg.rows);
        tracker.clearAnchor();
        log.info({ sessionId, clientRows: msg.rows }, "Frame requested, anchor cleared");
        framePusher.forceFull();
        // 顺便推送当前终端标题，确保客户端刷新后恢复
        if (tracker.title && socket.writable) {
          socket.write(serializeIpc({ type: "pty_title_change", sessionId, title: tracker.title }));
        }
      }
      if (msg.type === "pty_scroll_request" && msg.sessionId === sessionId && tracker) {
        if (msg.rows) tracker.setClientRows(msg.rows);
        if (msg.direction === "up") {
          tracker.scrollUp(msg.delta, msg.rows);
        } else {
          tracker.scrollDown(msg.delta, msg.rows);
        }
        const grid = tracker.extractGridAtOffset();
        const anchored = tracker.isAnchored();
        log.info({ direction: msg.direction, delta: msg.delta, anchored, anchorLineId: tracker.getAnchorLineId(), newestLineId: tracker.getNewestLineId(), rows: tracker.getTerminalRows() }, "Scroll handled");
        const framePayload = {
          type: "terminal_frame" as const,
          sessionId: msg.sessionId,
          payload: {
            mode: "full" as const,
            lines: grid,
            cursor: anchored ? undefined : tracker.getCursor(),
            isScrolled: anchored,
            anchorLineId: tracker.getAnchorLineId() ?? undefined,
            newestLineId: tracker.getNewestLineId(),
          },
        };
        socket.write(serializeIpc({
          type: "pty_terminal_frame",
          sessionId: msg.sessionId,
          frame: JSON.stringify(framePayload),
        }));
      }
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
            startFramePush();
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
  log.info({ sessionId, cols, rows }, "Session created, tracker initialized");
  tracker = new TerminalTracker(cols, rows);
  tracker.onTitleChange = (title) => {
    log.debug({ sessionId, title }, "Title change forwarded");
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({ type: "pty_title_change", sessionId, title }));
    }
  };

  const tap: DataTap = (data: string) => {
    lastOutputTime = Date.now();
    if (tracker) {
      tracker.feed(data);
    }

    // 有数据输出 → working
    if (currentPtyState !== "working") {
      currentPtyState = "working";
      sendPtyState("working");
    }

    // OSC 信号仅用于检测 approval_wait
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
      if (tracker) tracker.resize(newCols, newRows);
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "pty_resize", sessionId, cols: newCols, rows: newRows }));
      }
    },
    onSessionExit: (code: number) => {
      terminalState = TerminalState.EXITED;
      log.info({ sessionId, exitCode: code }, "PTY exited, cleaning up");
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
  log.info({ sessionId }, "PTY started, frame push active");

  socket.write(serializeIpc({ type: "pty_register", sessionId }));
  terminalState = TerminalState.RUNNING;
  startFramePush();

  setupIdleCheck();

  process.on("SIGTERM", () => {
    log.info({ sessionId }, "SIGTERM received, shutting down");
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    stopFramePush();
    if (tracker) tracker.dispose();
    if (socket.writable && sessionId) {
      socket.write(serializeIpc({ type: "pty_deregister", sessionId }));
    }
    ptyManager?.cleanup(143);
  });
}
