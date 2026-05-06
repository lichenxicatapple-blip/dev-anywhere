import { connect, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readTtySize, notifyUser } from "./terminal/tty.js";
import { PtyManager } from "./terminal/pty-manager.js";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { extractOscSignals, type PtySemanticState } from "./common/osc-extractor.js";
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
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  type ProviderAdapter,
  type ProviderHookContext,
  type ProviderId,
} from "./providers/index.js";

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
// 连续 spawn 失败到达阈值后停止自动 spawn，降为被动 tryConnect 轮询。
// 作用：环境异常（端口占用、依赖缺失、权限不足）时避免反复拉起短命子进程把日志刷爆。
const SPAWN_FAILURE_THRESHOLD = 3;

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

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

  // 监听 daemon 失败信号，让下面的 tryConnect 轮询能在 daemon 启动时就崩的场景下立刻抛诊断。
  // - 'exit'：进程启动成功后又退出（配置错误、端口占用、内部崩溃），带 code/signal。
  // - 'error'：spawn 本身失败（ENOENT 找不到 tsx/node 等），Node 文档说此时 'exit' may or may not 跟着 fire，
  //   所以显式监听补完备性。spawnScript 内部另装了一对只管日志的监听器，跟这里互不影响。
  let childFailed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  child.once("exit", (code, signal) => {
    childFailed = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.once("error", (err) => {
    childFailed = true;
    spawnError = err;
  });

  for (let i = 0; i < ENSURE_SERVICE_MAX_RETRIES; i++) {
    const delay = Math.min(ENSURE_SERVICE_INITIAL_DELAY_MS * (i + 1), ENSURE_SERVICE_MAX_DELAY_MS);
    await sleep(delay);

    if (childFailed) {
      log.error(
        { code: exitCode, signal: exitSignal, err: spawnError && String(spawnError) },
        "Serve daemon failed to start",
      );
      const detail = spawnError
        ? `spawn error=${String(spawnError)}`
        : `code=${exitCode}, signal=${exitSignal}`;
      throw new Error(
        `Serve daemon failed to start (${detail}). Check ${SERVICE_LOG_PATH} for details.`,
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
    `Failed to connect to dev-anywhere service after ${ENSURE_SERVICE_MAX_RETRIES} retries. Check ${SERVICE_LOG_PATH} for details.`,
  );
}

function waitForMessage<T extends IpcMessage["type"]>(
  socket: Socket,
  messageType: T,
): Promise<Extract<IpcMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const dispose = createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === messageType) {
        if (timeout) clearTimeout(timeout);
        dispose();
        resolve(msg as Extract<IpcMessage, { type: T }>);
      }
    });
    timeout = setTimeout(() => {
      dispose();
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, WAIT_FOR_MESSAGE_TIMEOUT_MS);
  });
}

class TerminalSession {
  private readonly fsm = createFSM<TerminalState>({
    initial: TerminalState.INIT,
    transitions: TERMINAL_TRANSITIONS,
    onTransition: (from, to) => log.info({ from, to }, "Terminal state transition"),
  });
  private readonly sessionCwd = process.env.INIT_CWD || process.cwd();
  // socket 在 run() 中连上 serve 后首次赋值；reconnect 会重新赋值为新实例
  private socket!: Socket;
  private sessionId: string | null = null;
  private hookContext: ProviderHookContext | null = null;
  private ptyManager: PtyManager | null = null;
  private lastOutputTime = 0;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private currentPtyState: PtySemanticState = "turn_complete";
  // headless terminal 在本进程维护，用于按需 serialize() 给远程 client
  private headlessTerminal: InstanceType<typeof HeadlessTerminal> | null = null;
  private serializeAddon: SerializeAddon | null = null;
  // 记录上次 bridge 状态避免重连抖动导致 banner 连刷；初值 null 让首次状态（无论真假）都打，启动时提示 remote viewing 是否就绪
  private lastBridgeConnected: boolean | null = null;
  // 收尾函数在 run() 里创建一次，PTY 退出与 SIGTERM 共用；内部通过 fsm EXITED 检查短路
  private cleanupAndExit!: (code: number) => void;

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly providerArgs: string[],
  ) {}

  async run(): Promise<void> {
    log.info("Terminal starting");
    this.fsm.transitionTo(TerminalState.CONNECTING_SERVICE);
    this.socket = await ensureService();

    await this.createSession();
    this.initHeadlessTerminal();
    this.cleanupAndExit = createExitHandler({
      fsm: this.fsm,
      getSocket: () => this.socket,
      getSessionId: () => this.sessionId,
      getIdleCheckTimer: () => this.idleCheckTimer,
    });

    this.setupSocketHandlers();
    this.startPtyManager();

    this.socket.write(
      serializeIpc({ type: "pty_register", sessionId: this.sessionId!, pid: process.pid }),
    );
    this.fsm.transitionTo(TerminalState.RUNNING);
    this.setupIdleCheck();

    process.on("SIGTERM", () => {
      log.info({ sessionId: this.sessionId }, "SIGTERM received, shutting down");
      this.cleanupAndExit(143);
    });
  }

  private async createSession(): Promise<void> {
    this.fsm.transitionTo(TerminalState.CREATING_SESSION);
    const responsePromise = waitForMessage(this.socket, "session_create_response");
    this.socket.write(
      serializeIpc({
        type: "session_create_request",
        mode: "pty",
        provider: this.provider.id,
        cwd: this.sessionCwd,
        name: tildify(this.sessionCwd),
        pid: process.pid,
      }),
    );
    const response = await responsePromise;
    if (response.error) {
      throw new Error(`Failed to create session: ${response.error}`);
    }
    this.sessionId = response.sessionId;
    this.hookContext = response.hook ?? null;
  }

  private initHeadlessTerminal(): void {
    const { cols, rows } = readTtySize(process.stdout);
    log.info(
      { sessionId: this.sessionId, cols, rows },
      "Session created, initializing headless terminal",
    );
    this.headlessTerminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    // UnicodeGraphemesAddon activate() 里会设置 activeVersion = '15-graphemes'
    this.headlessTerminal.loadAddon(this.serializeAddon);
    this.headlessTerminal.loadAddon(new UnicodeGraphemesAddon());
  }

  private startPtyManager(): void {
    this.ptyManager = new PtyManager({
      provider: this.provider,
      providerArgs: this.providerArgs,
      hook: this.hookContext ?? undefined,
      tap: (data) => this.handlePtyData(data),
      stdin: process.stdin,
      stdout: process.stdout,
      onResize: (newCols, newRows) => {
        if (this.headlessTerminal) this.headlessTerminal.resize(newCols, newRows);
        if (this.socket.writable && this.sessionId) {
          this.socket.write(
            serializeIpc({
              type: "pty_resize",
              sessionId: this.sessionId,
              cols: newCols,
              rows: newRows,
            }),
          );
        }
      },
      onSessionExit: (code: number) => {
        log.info({ sessionId: this.sessionId, exitCode: code }, "PTY exited, cleaning up");
        this.cleanupAndExit(code);
      },
    });
    this.ptyManager.start();
    log.info({ sessionId: this.sessionId }, "PTY started with headless terminal");
  }

  // PTY 的每一帧输出都要：追到 headless terminal 状态、推 binary IPC、跟 working/approval_wait 状态变化
  private handlePtyData(data: string): void {
    this.lastOutputTime = Date.now();

    if (this.headlessTerminal) this.headlessTerminal.write(data);

    if (this.socket.writable && this.sessionId) {
      this.socket.write(encodeBinaryIpcFrame(this.sessionId, Buffer.from(data, "utf-8")));
    }

    if (this.currentPtyState !== "working") {
      this.currentPtyState = "working";
      this.sendPtyState("working");
    }

    const signal = extractOscSignals(data);
    if (signal?.state === "approval_wait") {
      this.currentPtyState = "approval_wait";
      this.sendPtyState("approval_wait", { title: signal.title, tool: signal.tool });
    }
  }

  private sendPtyState(state: PtySemanticState, meta?: { title?: string; tool?: string }): void {
    if (!this.socket.writable || !this.sessionId) return;
    this.socket.write(
      serializeIpc({
        type: "pty_state_push",
        sessionId: this.sessionId,
        state,
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      }),
    );
    log.info(
      { sessionId: this.sessionId, state, title: meta?.title, tool: meta?.tool },
      "PTY state pushed",
    );
  }

  private handleBridgeStatus(connected: boolean): void {
    if (this.lastBridgeConnected === connected) return;
    this.lastBridgeConnected = connected;
    log.info({ connected }, "Bridge status changed, notifying user");
    notifyUser(connected ? "relay online" : "relay offline — remote viewing unavailable");
  }

  private setupSocketHandlers(): void {
    createIpcReader(this.socket, (msg: IpcMessage) => {
      if (msg.type === "pty_input" && msg.sessionId === this.sessionId) {
        log.debug({ sessionId: this.sessionId, bytes: msg.data.length }, "Remote input received");
        this.ptyManager?.write(msg.data);
      } else if (msg.type === "bridge_status") {
        this.handleBridgeStatus(msg.connected);
      } else if (msg.type === "pty_subscribe" && msg.sessionId === this.sessionId) {
        if (this.serializeAddon && this.headlessTerminal) {
          const data = this.serializeAddon.serialize();
          this.socket.write(
            serializeIpc({
              type: "pty_snapshot",
              sessionId: msg.sessionId,
              cols: this.headlessTerminal.cols,
              rows: this.headlessTerminal.rows,
              data,
              requestId: msg.requestId,
            }),
          );
          log.info(
            {
              sessionId: this.sessionId,
              cols: this.headlessTerminal.cols,
              rows: this.headlessTerminal.rows,
              bytes: data.length,
            },
            "Snapshot sent via IPC",
          );
        }
      }
    });

    this.socket.on("close", () => {
      log.info("Serve socket closed");
      if (!this.fsm.isIn([TerminalState.RECONNECTING, TerminalState.EXITED])) {
        this.fsm.transitionTo(TerminalState.RECONNECTING);
        this.reconnectToServe();
      }
    });

    // socket error 通常和 close 成对出现；这里只记 warn 避免静默吞错，重连仍由 close handler 触发
    this.socket.on("error", (err) => {
      log.warn({ err: err.message }, "Serve socket error");
    });
  }

  // 超过 IDLE_THRESHOLD_MS 无 PTY 输出则从 working 翻回 turn_complete
  private setupIdleCheck(): void {
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = setInterval(() => {
      if (this.lastOutputTime > 0 && Date.now() - this.lastOutputTime > IDLE_THRESHOLD_MS) {
        this.lastOutputTime = 0;
        if (this.currentPtyState === "working") {
          this.currentPtyState = "turn_complete";
          this.sendPtyState("turn_complete");
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  private async reconnectToServe(): Promise<void> {
    log.info("Serve connection lost, starting reconnection");

    // 两条路径都不该再继续 spawn daemon：
    //   - STOPPED=true：用户主动 dev-anywhere stop，不要对抗用户意图。
    //   - consecutiveSpawnFailures 跨过阈值：说明环境有持续性问题，spawn 再多也白搭。
    // 进入 passive 后仅做 tryConnect 等待，daemon 起来或用户 dev-anywhere start 后自动恢复。
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

        if (degraded) notifyUser("serve daemon reachable, reconnected");
        consecutiveSpawnFailures = 0;

        this.socket = newSocket;
        log.info({ attempt: i + 1, sessionId: this.sessionId }, "Reconnected to serve");

        this.setupSocketHandlers();

        if (this.sessionId) {
          this.fsm.transitionTo(TerminalState.CREATING_SESSION);
          this.socket.write(
            serializeIpc({
              type: "session_create_request",
              mode: "pty",
              provider: this.provider.id,
              cwd: this.sessionCwd,
              name: tildify(this.sessionCwd),
              pid: process.pid,
              sessionId: this.sessionId,
            }),
          );
          const resp = await waitForMessage(this.socket, "session_create_response");
          if (!resp.error) {
            this.sessionId = resp.sessionId;
            this.socket.write(
              serializeIpc({ type: "pty_register", sessionId: this.sessionId, pid: process.pid }),
            );
            this.fsm.transitionTo(TerminalState.RUNNING);
            log.info({ sessionId: this.sessionId }, "Session re-registered after reconnect");
          }
        } else {
          this.fsm.transitionTo(TerminalState.RUNNING);
        }

        return;
      } catch (err) {
        // passive 模式走 tryConnect，失败返回 null 不抛；这里只可能是 ensureService spawn 失败
        if (!passive) {
          consecutiveSpawnFailures++;
          if (consecutiveSpawnFailures === SPAWN_FAILURE_THRESHOLD) {
            notifyUser(
              `serve daemon spawn failed ${SPAWN_FAILURE_THRESHOLD}x — auto-spawn disabled; check environment or run 'dev-anywhere start'`,
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
}

function providerFromEnv(): ProviderId {
  return process.env.DEV_ANYWHERE_PROVIDER === "codex" ? "codex" : "claude";
}

export async function startTerminal(
  providerArgs: string[],
  providerId: ProviderId = providerFromEnv(),
): Promise<void> {
  await new TerminalSession(PROVIDERS[providerId], providerArgs).run();
}
