import { connect, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataTap } from "./terminal/tap.js";
import { PtyManager } from "./terminal/pty-manager.js";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { extractOscSignals, type PtySemanticState } from "./terminal/osc-extractor.js";
import { TerminalState, TERMINAL_TRANSITIONS, createExitHandler } from "./terminal/state.js";
import { SOCK_PATH, STOPPED_PATH, SERVICE_LOG_PATH, tildify } from "./common/paths.js";
import { spawnScript } from "./common/env.js";
import {
  createIpcReader,
  serializeIpc,
  encodeBinaryIpcFrame,
  type IpcMessage,
} from "./ipc/ipc-protocol.js";
import { terminalLogger as log } from "./common/logger.js";
import { createFSM } from "./common/state-machine.js";

// serve daemon 自动拉起的连接重试参数
const ENSURE_SERVICE_MAX_RETRIES = 20;
const ENSURE_SERVICE_INITIAL_DELAY_MS = 100;
const ENSURE_SERVICE_MAX_DELAY_MS = 2_000;

// 等待特定类型 IPC 消息的默认超时
const WAIT_FOR_MESSAGE_TIMEOUT_MS = 10_000;

// idle 检测：超过 IDLE_THRESHOLD_MS 无输出则翻转 working -> turn_complete
const IDLE_CHECK_INTERVAL_MS = 3_000;
const IDLE_THRESHOLD_MS = 3_000;

// serve 连接断开后的重连重试参数
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5_000;
// 连续 spawn 失败 N 次后停止自动 spawn，降级为被动 tryConnect 轮询。
// 避免环境坏（port 占用、install 坏、权限）时持续刷短命子进程。
const SPAWN_FAILURE_THRESHOLD = 3;

function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

async function ensureService(autoStart = true): Promise<Socket> {
  const existing = await tryConnect(SOCK_PATH);
  if (existing) {
    log.info("Connected to existing service");
    return existing;
  }

  if (!autoStart) throw new Error("Service is not running");

  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  log.info("Auto-starting serve daemon");
  const child = spawnScript(new URL("./serve", import.meta.url), [], { logger: log });

  // 挂个独立 exit 监听，让 retry 循环能快速短路。
  // spawnScript 的 logger handler 已经另装了 once("exit") 管日志，这两个 listener 互不影响。
  // 用扁平 flag 变量而非对象，绕开 TS 对 callback 内 let 赋值的窄化缺陷。
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  for (let i = 0; i < ENSURE_SERVICE_MAX_RETRIES; i++) {
    const delay = Math.min(ENSURE_SERVICE_INITIAL_DELAY_MS * (i + 1), ENSURE_SERVICE_MAX_DELAY_MS);
    await sleep(delay);

    if (childExited) {
      log.error({ code: exitCode, signal: exitSignal }, "Serve daemon exited during startup");
      throw new Error(
        `Serve daemon exited during startup (code=${exitCode}, signal=${exitSignal}). Check ${SERVICE_LOG_PATH} for details.`,
      );
    }

    const socket = await tryConnect(SOCK_PATH);
    if (socket) {
      log.info({ attempt: i + 1 }, "Connected to service after retry");
      return socket;
    }
  }

  log.error({ maxRetries: ENSURE_SERVICE_MAX_RETRIES }, "Failed to connect to service");
  throw new Error(
    `Failed to connect to cc-anywhere service after ${ENSURE_SERVICE_MAX_RETRIES} retries. Check ${SERVICE_LOG_PATH} for details.`,
  );
}

function waitForMessage(socket: Socket, messageType: string): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, WAIT_FOR_MESSAGE_TIMEOUT_MS);

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
  const fsm = createFSM<TerminalState>({
    initial: TerminalState.INIT,
    transitions: TERMINAL_TRANSITIONS,
    onTransition: (from, to) => log.info({ from, to }, "Terminal state transition"),
  });
  fsm.transitionTo(TerminalState.CONNECTING_SERVICE);
  let socket = await ensureService();
  let sessionId: string | null = null;
  let ptyManager: PtyManager | null = null;
  let lastOutputTime = 0;
  let idleCheckTimer: NodeJS.Timeout | null = null;
  const sessionCwd = process.env.INIT_CWD || process.cwd();
  let currentPtyState: PtySemanticState = "turn_complete";

  // headless terminal 在 terminal.ts 进程内维护，用于按需 serialize() 给远程 client
  let headlessTerminal: InstanceType<typeof HeadlessTerminal> | null = null;
  let serializeAddon: SerializeAddon | null = null;

  // 记住上一次 bridge 状态避免重连期间 connected/disconnected 快速抖动打多行 banner，
  // 初值 null 保证首个状态（无论真假）都会打，方便用户在启动就看到 remote viewing 是否就绪
  let lastBridgeConnected: boolean | null = null;
  function handleBridgeStatus(connected: boolean): void {
    if (lastBridgeConnected === connected) return;
    lastBridgeConnected = connected;
    const banner = connected
      ? "\n\x1b[32m[cc-anywhere] relay online\x1b[0m\n"
      : "\n\x1b[33m[cc-anywhere] relay offline — remote viewing unavailable\x1b[0m\n";
    process.stderr.write(banner);
  }

  function sendPtyState(state: PtySemanticState, meta?: { title?: string; tool?: string }): void {
    if (!socket.writable || !sessionId) return;
    socket.write(
      serializeIpc({
        type: "pty_state_push",
        sessionId,
        state,
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      }),
    );
    log.info({ sessionId, state, title: meta?.title, tool: meta?.tool }, "PTY state pushed");
  }

  function setupSocketHandlers(): void {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === sessionId) {
        log.debug({ sessionId, bytes: msg.data.length }, "Remote input received");
        ptyManager?.write(msg.data);
      } else if (msg.type === "bridge_status") {
        handleBridgeStatus(msg.connected);
      } else if (msg.type === "pty_subscribe" && msg.sessionId === sessionId) {
        if (serializeAddon && headlessTerminal) {
          const data = serializeAddon.serialize();
          socket.write(
            serializeIpc({
              type: "pty_snapshot",
              sessionId: msg.sessionId,
              cols: headlessTerminal.cols,
              rows: headlessTerminal.rows,
              data,
            }),
          );
          log.info(
            {
              sessionId,
              cols: headlessTerminal.cols,
              rows: headlessTerminal.rows,
              bytes: data.length,
            },
            "Snapshot sent via IPC",
          );
        }
      }
    });

    socket.on("close", () => {
      log.info("Serve socket closed");
      if (!fsm.isIn([TerminalState.RECONNECTING, TerminalState.EXITED])) {
        fsm.transitionTo(TerminalState.RECONNECTING);
        reconnectToServe();
      }
    });

    // socket error 通常和 close 事件成对出现，这里记 warn 避免静默吞错，
    // 实际的重连仍由 close handler 触发。
    socket.on("error", (err) => {
      log.warn({ err: err.message }, "Serve socket error");
    });
  }

  // idle/working 检测：超过 IDLE_THRESHOLD_MS 无输出则从 working 转为 turn_complete
  function setupIdleCheck(): void {
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    idleCheckTimer = setInterval(() => {
      if (lastOutputTime > 0 && Date.now() - lastOutputTime > IDLE_THRESHOLD_MS) {
        lastOutputTime = 0;
        if (currentPtyState === "working") {
          currentPtyState = "turn_complete";
          sendPtyState("turn_complete");
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  async function reconnectToServe(): Promise<void> {
    log.info("Serve connection lost, starting reconnection");

    // STOPPED=true（用户 cc-anywhere stop）与 spawn 反复失败（环境坏）两种路径都不该 spawn。
    // consecutiveSpawnFailures 跨过阈值后进入 degraded，只做 tryConnect 被动等待用户修复或手动拉起。
    let consecutiveSpawnFailures = 0;

    for (let i = 0; ; i++) {
      await sleep(Math.min(RECONNECT_INITIAL_DELAY_MS * (i + 1), RECONNECT_MAX_DELAY_MS));

      const stopped = existsSync(STOPPED_PATH);
      const degraded = consecutiveSpawnFailures >= SPAWN_FAILURE_THRESHOLD;
      const passive = stopped || degraded;

      try {
        log.debug({ attempt: i + 1, stopped, degraded }, "Reconnect attempt");
        const newSocket = passive ? await tryConnect(SOCK_PATH) : await ensureService();
        if (!newSocket) continue;

        // 成功连上：若之前在 degraded，打恢复 banner + 重置 counter
        if (degraded) {
          process.stderr.write(
            "\n\x1b[32m[cc-anywhere] serve daemon 已恢复，自动重连已继续\x1b[0m\n",
          );
        }
        consecutiveSpawnFailures = 0;

        socket = newSocket;
        log.info({ attempt: i + 1, sessionId }, "Reconnected to serve");

        setupSocketHandlers();

        if (sessionId) {
          fsm.transitionTo(TerminalState.CREATING_SESSION);
          socket.write(
            serializeIpc({
              type: "session_create_request",
              mode: "pty",
              cwd: sessionCwd,
              name: tildify(sessionCwd),
              pid: process.pid,
              sessionId,
            }),
          );
          const resp = await waitForMessage(socket, "session_create_response");
          if (resp.type === "session_create_response" && !resp.error) {
            sessionId = resp.sessionId;
            socket.write(serializeIpc({ type: "pty_register", sessionId, pid: process.pid }));
            fsm.transitionTo(TerminalState.RUNNING);
            log.info({ sessionId }, "Session re-registered after reconnect");
          }
        } else {
          fsm.transitionTo(TerminalState.RUNNING);
        }

        return;
      } catch (err) {
        // passive 模式不该触发 catch（tryConnect 返回 null 不抛）；这里只处理 ensureService 的 spawn 失败
        if (!passive) {
          consecutiveSpawnFailures++;
          if (consecutiveSpawnFailures === SPAWN_FAILURE_THRESHOLD) {
            process.stderr.write(
              `\n\x1b[33m[cc-anywhere] serve daemon 连续启动失败 ${SPAWN_FAILURE_THRESHOLD} 次，停止自动拉起；请检查环境或手动运行 cc-anywhere start\x1b[0m\n`,
            );
          }
        }
        log.debug(
          { err: err instanceof Error ? err.message : err, attempt: i + 1, degraded },
          "Reconnect attempt failed",
        );
      }
    }
  }

  // 请求创建 PTY 会话
  fsm.transitionTo(TerminalState.CREATING_SESSION);
  const responsePromise = waitForMessage(socket, "session_create_response");
  socket.write(
    serializeIpc({
      type: "session_create_request",
      mode: "pty",
      cwd: sessionCwd,
      name: tildify(sessionCwd),
      pid: process.pid,
    }),
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
  log.info({ sessionId, cols, rows }, "Session created, initializing headless terminal");

  headlessTerminal = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  serializeAddon = new SerializeAddon();
  const unicodeAddon = new UnicodeGraphemesAddon();
  headlessTerminal.loadAddon(serializeAddon);
  headlessTerminal.loadAddon(unicodeAddon);
  // addon activate() 里已经设置 activeVersion = '15-graphemes'

  const tap: DataTap = (data: string) => {
    lastOutputTime = Date.now();

    // headless terminal 状态追踪
    if (headlessTerminal) {
      headlessTerminal.write(data);
    }

    // binary IPC 帧推送到 serve
    if (socket.writable && sessionId) {
      socket.write(encodeBinaryIpcFrame(sessionId, Buffer.from(data, "utf-8")));
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
      sendPtyState("approval_wait", { title: signal.title, tool: signal.tool });
    }
  };

  setupSocketHandlers();

  // pty_deregister 由 serve 负责 session 清理（数据目录、relay 通知等），
  // terminal fd 随进程退出由 OS 关闭。收尾逻辑与 SIGTERM 共享同一实例避免重复。
  const cleanupAndExit = createExitHandler({
    fsm,
    getSocket: () => socket,
    getSessionId: () => sessionId,
    getIdleCheckTimer: () => idleCheckTimer,
  });

  ptyManager = new PtyManager({
    claudeArgs,
    tap,
    stdin: process.stdin,
    stdout: process.stdout,
    onResize: (newCols, newRows) => {
      if (headlessTerminal) headlessTerminal.resize(newCols, newRows);
      if (socket.writable && sessionId) {
        socket.write(serializeIpc({ type: "pty_resize", sessionId, cols: newCols, rows: newRows }));
      }
    },
    onSessionExit: (code: number) => {
      log.info({ sessionId, exitCode: code }, "PTY exited, cleaning up");
      cleanupAndExit(code);
    },
  });
  ptyManager.start();
  log.info({ sessionId }, "PTY started with headless terminal");

  socket.write(serializeIpc({ type: "pty_register", sessionId, pid: process.pid }));
  fsm.transitionTo(TerminalState.RUNNING);

  setupIdleCheck();

  process.on("SIGTERM", () => {
    log.info({ sessionId }, "SIGTERM received, shutting down");
    cleanupAndExit(143);
  });
}
