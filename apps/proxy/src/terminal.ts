import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { readTtySize, notifyUser } from "./terminal/tty.js";
import { PtyManager } from "./terminal/pty-manager.js";
import { resolveTerminalCwd } from "./terminal/cwd.js";
import { ensureService, tryConnect, waitForMessage } from "./terminal/serve-bootstrap.js";
import { createIdleChecker, type IdleChecker } from "./terminal/idle-checker.js";
import { swapServeSocket } from "./terminal/serve-socket-swap.js";
import {
  appendPtySemanticTextTail,
  extractOscSequences,
  extractOscSignals,
  extractTextSignals,
} from "./common/osc-extractor.js";
import { createFSM, type PtySemanticState } from "@dev-anywhere/shared";
import { shouldReleaseTextApprovalOnInput } from "./common/pty-approval-state.js";
import {
  decidePtySemanticTransition,
  shouldStartPtyTurnOnInput,
} from "./common/pty-semantic-machine.js";
import { PtyRenderSequencer } from "./common/pty-render-sequencer.js";
import {
  createCodexXtermHistoryCompat,
  type CodexXtermHistoryCompat,
} from "./common/codex-xterm-history-compat.js";
import { PtySynchronizedOutputCoalescer } from "./common/pty-synchronized-output-coalescer.js";
import { sanitizeProviderErrorTail } from "./common/codex-session-conflict.js";
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
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  KIMI_PROVIDER,
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
  kimi: KIMI_PROVIDER,
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
  private semanticTextTail = "";
  private textApprovalWaitActive = false;
  private renderSequencer: PtyRenderSequencer | null = null;
  private xtermHistoryCompat: CodexXtermHistoryCompat | null = null;
  private xtermHistoryCompatReported = false;
  private readonly synchronizedOutput: PtySynchronizedOutputCoalescer;
  private ptyStateSeq = 0;
  private remoteDetached = false;
  // 记录上次 bridge 连接状态，避免重连抖动重复打印 banner；
  // 初值 null 确保首次状态变更（无论 true/false）都触发一次输出
  private lastBridgeConnected: boolean | null = null;
  // 收尾函数在 run() 里创建一次，PTY 退出与 SIGTERM 共用；内部通过 fsm EXITED 检查短路
  private cleanupAndExit!: (code: number, errorTail?: string) => void;
  private providerOutputTail = "";

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly providerArgs: string[],
  ) {
    this.synchronizedOutput = new PtySynchronizedOutputCoalescer({
      emit: (data) => this.emitRenderData(data),
      onOverflow: (event) => {
        log.warn(
          { sessionId: this.sessionId, ...event },
          "PTY synchronized-output transaction exceeded buffer limit; streaming remainder",
        );
      },
    });
  }

  async run(): Promise<void> {
    log.info("Terminal starting");
    this.fsm.transitionTo(TerminalState.CONNECTING_SERVICE);
    this.socket = await ensureService();

    await this.createSession();
    const initialSize = this.initRenderSequencer();
    this.cleanupAndExit = createExitHandler({
      fsm: this.fsm,
      getSocket: () => this.socket,
      getSessionId: () => this.sessionId,
      stopIdleChecker: () => this.idleChecker?.stop(),
      disposeRenderResources: () => {
        this.disposePendingRenderData();
        this.renderSequencer?.dispose();
        this.renderSequencer = null;
        this.xtermHistoryCompat = null;
      },
    });

    this.setupSocketHandlers();
    this.startPtyManager(initialSize);

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

  private initRenderSequencer(): { cols: number; rows: number } {
    const { cols, rows } = readTtySize(process.stdout);
    log.info(
      { sessionId: this.sessionId, cols, rows },
      "Session created, initializing PTY render sequencer",
    );
    this.renderSequencer = new PtyRenderSequencer({ cols, rows });
    this.xtermHistoryCompat = createCodexXtermHistoryCompat(this.provider.id, rows, process.env);
    return { cols, rows };
  }

  private startPtyManager(initialSize: { cols: number; rows: number }): void {
    this.ptyManager = new PtyManager({
      provider: this.provider,
      providerArgs: this.providerArgs,
      cwd: this.sessionCwd,
      initialSize,
      hook: this.hookContext ?? undefined,
      tap: (data) => this.handlePtyData(data),
      onInput: (data) => this.updateSemanticStateOnInput(data),
      stdin: process.stdin,
      stdout: process.stdout,
      onResize: (newCols, newRows) => {
        this.flushPendingRenderData();
        this.xtermHistoryCompat?.setTerminalRows(newRows);
        const outputSeq = this.renderSequencer?.resize(newCols, newRows);
        if (
          outputSeq !== null &&
          outputSeq !== undefined &&
          this.socket.writable &&
          this.sessionId
        ) {
          this.socket.write(
            serializeIpc({
              type: "pty_resize",
              sessionId: this.sessionId,
              cols: newCols,
              rows: newRows,
              outputSeq,
            }),
          );
        }
      },
      onSessionExit: (code: number) => {
        log.info({ sessionId: this.sessionId, exitCode: code }, "PTY exited, cleaning up");
        const errorTail = code === 0 ? "" : sanitizeProviderErrorTail(this.providerOutputTail);
        this.cleanupAndExit(code, errorTail || undefined);
      },
    });
    this.ptyManager.start();
    log.info({ sessionId: this.sessionId }, "PTY started with headless terminal");
  }

  // PTY 的每一帧输出都要：追到 headless terminal 状态、推 binary IPC、提取 provider 语义事件
  private handlePtyData(data: string): void {
    this.lastOutputTime = Date.now();
    this.providerOutputTail = `${this.providerOutputTail}${data}`.slice(-8_192);
    const previousRewriteCount = this.xtermHistoryCompat?.stats.rewrittenTransactions ?? 0;
    const renderData = this.xtermHistoryCompat?.push(data) ?? data;
    this.synchronizedOutput.push(renderData);
    this.reportXtermHistoryCompatRewrite(previousRewriteCount);

    const oscSequences = extractOscSequences(data);
    const oscSignal = extractOscSignals(data, this.provider.id);
    this.semanticTextTail = appendPtySemanticTextTail(this.semanticTextTail, data);
    const textSignal = oscSignal
      ? null
      : extractTextSignals(this.semanticTextTail, this.provider.id);
    const signal = oscSignal ?? textSignal;
    if (textSignal?.state === "approval_wait") {
      this.textApprovalWaitActive = true;
      this.semanticTextTail = "";
    }
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
      allowTitleOnlyApprovalRelease: !this.textApprovalWaitActive,
    });
    this.currentPtyState = decision.nextState;
    if (decision.nextState !== "approval_wait") {
      this.textApprovalWaitActive = false;
    }
    if (decision.emit) {
      this.sendPtyState(decision.nextState, decision.meta);
    }
  }

  /**
   * Feed exactly the same canonical stream to the proxy-side xterm and the Web client. Keeping
   * outputSeq on that stream means snapshots and replay frames cannot observe a sequence gap when
   * the Codex compatibility layer temporarily buffers a synchronized-output transaction.
   */
  private emitRenderData(data: string): void {
    if (!data) return;
    const outputSeq = this.renderSequencer?.write(data);
    if (outputSeq === null || outputSeq === undefined) return;

    if (!this.remoteDetached && this.socket.writable && this.sessionId) {
      this.socket.write(
        encodeBinaryIpcFrame(this.sessionId, Buffer.from(data, "utf-8"), outputSeq),
      );
    }
  }

  private flushPendingRenderData(): void {
    this.synchronizedOutput.push(this.xtermHistoryCompat?.flush() ?? "");
    this.synchronizedOutput.flush();
  }

  private disposePendingRenderData(): void {
    this.synchronizedOutput.push(this.xtermHistoryCompat?.flush() ?? "");
    this.synchronizedOutput.dispose();
  }

  private reportXtermHistoryCompatRewrite(previousRewriteCount: number): void {
    const stats = this.xtermHistoryCompat?.stats;
    if (!stats || stats.rewrittenTransactions === previousRewriteCount) return;
    const payload = {
      sessionId: this.sessionId,
      rewrittenTransactions: stats.rewrittenTransactions,
      preservedRows: stats.preservedRows,
    };
    if (!this.xtermHistoryCompatReported) {
      this.xtermHistoryCompatReported = true;
      log.info(payload, "Codex xterm history compatibility activated");
    } else {
      log.debug(payload, "Codex xterm history transaction rewritten");
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
        seq: ++this.ptyStateSeq,
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      }),
    );
    log.info(
      {
        sessionId: this.sessionId,
        state,
        seq: this.ptyStateSeq,
        title: meta?.title,
        tool: meta?.tool,
      },
      "PTY semantic event pushed",
    );
  }

  private updateSemanticStateOnInput(data: string): void {
    if (
      this.textApprovalWaitActive &&
      this.currentPtyState === "approval_wait" &&
      shouldReleaseTextApprovalOnInput(data)
    ) {
      this.textApprovalWaitActive = false;
      this.currentPtyState = "working";
      this.sendPtyState("working");
      return;
    }

    if (!shouldStartPtyTurnOnInput(this.currentPtyState, data)) return;
    this.currentPtyState = "working";
    this.sendPtyState("working");
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
            { sessionId: this.sessionId, traceId: msg.traceId, bytes: msg.data.length },
            "Remote input received",
          );
          this.ptyManager?.write(msg.data);
        } else if (msg.type === "pty_detach" && msg.sessionId === this.sessionId) {
          this.detachRemoteView();
        } else if (msg.type === "bridge_status") {
          this.handleBridgeStatus(msg.connected);
        } else if (msg.type === "pty_subscribe" && msg.sessionId === this.sessionId) {
          if (this.renderSequencer) {
            const responseSocket = this.socket;
            this.renderSequencer.captureSnapshot((snapshot) => {
              if (this.socket !== responseSocket || !responseSocket.writable) return;
              responseSocket.write(
                serializeIpc({
                  type: "pty_snapshot",
                  sessionId: msg.sessionId,
                  ...snapshot,
                  requestId: msg.requestId,
                }),
              );
              log.info(
                {
                  sessionId: this.sessionId,
                  cols: snapshot.cols,
                  rows: snapshot.rows,
                  bytes: snapshot.data.length,
                  outputSeq: snapshot.outputSeq,
                },
                "Snapshot sent via IPC",
              );
            });
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
  const provider = process.env.DEV_ANYWHERE_PROVIDER;
  return provider === "codex" || provider === "kimi" ? provider : "claude";
}

export async function startTerminal(
  providerArgs: string[],
  providerId: ProviderId = providerFromEnv(),
): Promise<void> {
  await new TerminalSession(PROVIDERS[providerId], providerArgs).run();
}
