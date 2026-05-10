import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { readTtySize, notifyUser } from "./terminal/tty.js";
import { PtyManager } from "./terminal/pty-manager.js";
import { resolveTerminalCwd } from "./terminal/cwd.js";
import { ensureService, tryConnect, waitForMessage } from "./terminal/serve-bootstrap.js";
import { createIdleChecker, type IdleChecker } from "./terminal/idle-checker.js";
import { swapServeSocket } from "./terminal/serve-socket-swap.js";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import {
  extractOscSequences,
  extractOscSignals,
  type PtySemanticState,
} from "./common/osc-extractor.js";
import { decidePtySemanticTransition } from "./common/pty-semantic-machine.js";
import { TerminalState, TERMINAL_TRANSITIONS, createExitHandler } from "./terminal/state.js";
import { existsSync } from "node:fs";
import { SOCK_PATH, STOPPED_PATH, tildify } from "./common/paths.js";
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

class TerminalSession {
  private readonly fsm = createFSM<TerminalState>({
    initial: TerminalState.INIT,
    transitions: TERMINAL_TRANSITIONS,
    onTransition: (from, to) => log.info({ from, to }, "Terminal state transition"),
  });
  private readonly sessionCwd = resolveTerminalCwd();
  // socket 在 run() 中连上 serve 后首次赋值；reconnect 会重新赋值为新实例
  private socket!: Socket;
  private sessionId: string | null = null;
  private hookContext: ProviderHookContext | null = null;
  private ptyManager: PtyManager | null = null;
  private lastOutputTime = 0;
  private idleChecker: IdleChecker | null = null;
  private currentPtyState: PtySemanticState = "turn_complete";
  // headless terminal 在本进程维护，用于按需 serialize() 给远程 client
  private headlessTerminal: InstanceType<typeof HeadlessTerminal> | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private outputSeq = 0;
  private remoteDetached = false;
  // 记录上次 bridge 连接状态，避免重连抖动重复打印 banner；
  // 初值 null 确保首次状态变更（无论 true/false）都触发一次输出
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
      stopIdleChecker: () => this.idleChecker?.stop(),
      disposeRenderResources: () => {
        this.headlessTerminal?.dispose();
        this.headlessTerminal = null;
        this.serializeAddon = null;
      },
    });

    this.setupSocketHandlers();
    this.startPtyManager();

    this.socket.write(
      serializeIpc({ type: "pty_register", sessionId: this.sessionId!, pid: process.pid }),
    );
    this.replayCurrentPtyState();
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
      cwd: this.sessionCwd,
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

  // PTY 的每一帧输出都要：追到 headless terminal 状态、推 binary IPC、提取 provider 语义事件
  private handlePtyData(data: string): void {
    this.lastOutputTime = Date.now();
    this.outputSeq += 1;

    if (this.headlessTerminal) this.headlessTerminal.write(data);

    if (!this.remoteDetached && this.socket.writable && this.sessionId) {
      this.socket.write(
        encodeBinaryIpcFrame(this.sessionId, Buffer.from(data, "utf-8"), this.outputSeq),
      );
    }

    const oscSequences = extractOscSequences(data);
    const signal = extractOscSignals(data, this.provider.id);
    if (oscSequences.length > 0) {
      log.debug(
        {
          sessionId: this.sessionId,
          oscSequences,
          signal,
        },
        "PTY OSC sequences parsed",
      );
    }
    if (signal?.title) {
      this.sendTerminalTitle(signal.title);
    }

    // 语义状态机决策（六条规则）抽到 common/pty-semantic-machine：terminal 进程仅 emit 事件，
    // session FSM 副作用由 serve 端在收到 pty_state IPC 后驱动。
    const decision = decidePtySemanticTransition({
      currentState: this.currentPtyState,
      signal: signal ?? null,
    });
    this.currentPtyState = decision.nextState;
    if (decision.emit) {
      this.sendPtyState(decision.nextState, decision.meta);
    }
  }

  private sendTerminalTitle(title: string): void {
    if (this.remoteDetached || !this.socket.writable || !this.sessionId) return;
    this.socket.write(
      serializeIpc({
        type: "pty_title_change",
        sessionId: this.sessionId,
        title,
      }),
    );
  }

  private sendPtyState(state: PtySemanticState, meta?: { title?: string; tool?: string }): void {
    if (this.remoteDetached || !this.socket.writable || !this.sessionId) return;
    this.socket.write(
      serializeIpc({
        type: "pty_semantic_event",
        sessionId: this.sessionId,
        state,
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      }),
    );
    log.info(
      { sessionId: this.sessionId, state, title: meta?.title, tool: meta?.tool },
      "PTY semantic event pushed",
    );
  }

  private replayCurrentPtyState(): void {
    if (this.currentPtyState === "turn_complete") return;
    this.sendPtyState(this.currentPtyState);
  }

  private handleBridgeStatus(connected: boolean): void {
    if (this.remoteDetached) return;
    if (this.lastBridgeConnected === connected) return;
    this.lastBridgeConnected = connected;
    log.info({ connected }, "Bridge status changed, notifying user");
    notifyUser(connected ? "relay online" : "relay offline — remote viewing unavailable");
  }

  private setupSocketHandlers(): void {
    createIpcReader(
      this.socket,
      (msg: IpcMessage) => {
        if (msg.type === "pty_input" && msg.sessionId === this.sessionId) {
          log.debug(
            { sessionId: this.sessionId, bytes: msg.data.length },
            "Remote input received",
          );
          this.ptyManager?.write(msg.data);
        } else if (msg.type === "pty_detach" && msg.sessionId === this.sessionId) {
          this.detachRemoteView();
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
                outputSeq: this.outputSeq,
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
      },
      undefined,
      (err, line) => {
        log.warn(
          { err: err.message, lineLen: line.length },
          "Serve IPC message dropped (parse/schema error)",
        );
      },
    );

    this.socket.on("close", () => {
      log.info("Serve socket closed");
      if (this.remoteDetached) {
        log.info("Remote view detached, skipping serve reconnect");
        return;
      }
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
    this.idleChecker?.stop();
    this.idleChecker = createIdleChecker({
      intervalMs: IDLE_CHECK_INTERVAL_MS,
      thresholdMs: IDLE_THRESHOLD_MS,
      getLastOutputTime: () => this.lastOutputTime,
      setLastOutputTime: (value) => {
        this.lastOutputTime = value;
      },
      getCurrentState: () => this.currentPtyState,
      onIdle: () => {
        this.currentPtyState = "turn_complete";
        this.sendPtyState("turn_complete");
      },
    });
    this.idleChecker.start();
  }

  private async reconnectToServe(): Promise<void> {
    log.info("Serve connection lost, starting reconnection");

    // 两条路径都不该再继续 spawn daemon：
    //   - STOPPED=true：用户主动 dev-anywhere stop，不要对抗用户意图。
    //   - consecutiveSpawnFailures 跨过阈值：说明环境有持续性问题，spawn 再多也白搭。
    // 进入 passive 后仅做 tryConnect 等待，daemon 起来或用户 dev-anywhere start 后自动恢复。
    let consecutiveSpawnFailures = 0;

    for (let i = 0; ; i++) {
      if (this.remoteDetached) return;
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

        this.socket = swapServeSocket(this.socket, newSocket);
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
            this.replayCurrentPtyState();
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

  private detachRemoteView(): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.remoteDetached = true;
    this.sessionId = null;
    this.hookContext = null;
    this.currentPtyState = "turn_complete";
    log.info({ sessionId }, "Remote view detached; local PTY keeps running");
    notifyUser("remote viewing detached");
    if (this.socket.writable) this.socket.end();
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
