import * as pty from "node-pty";
import type { IPty } from "node-pty";
import {
  ControlErrorCode,
  SessionState,
  encodeBinaryFrame,
  serializeControl,
  type PtySemanticState,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { findCodexActiveWriter } from "../common/codex-active-writer.js";
import {
  classifyCodexActiveWriterError,
  codexActiveWriterMessage,
  sanitizeProviderErrorTail,
} from "../common/codex-session-conflict.js";
import {
  appendPtySemanticTextTail,
  extractOscWorkingDirectory,
  extractOscSequences,
  extractOscSignals,
  extractTextSignals,
} from "../common/osc-extractor.js";
import { shouldReleaseTextApprovalOnInput } from "../common/pty-approval-state.js";
import {
  decidePtySemanticTransition,
  shouldStartPtyTurnOnInput,
} from "../common/pty-semantic-machine.js";
import { PtyRenderSequencer } from "../common/pty-render-sequencer.js";
import {
  createCodexXtermHistoryCompat,
  type CodexXtermHistoryCompat,
} from "../common/codex-xterm-history-compat.js";
import { PtySynchronizedOutputCoalescer } from "../common/pty-synchronized-output-coalescer.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  KIMI_PROVIDER,
  type ProviderAdapter,
  type ProviderHookContext,
  type ProviderId,
} from "../providers/index.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";

const IDLE_CHECK_INTERVAL_MS = 3_000;
const IDLE_THRESHOLD_MS = 3_000;
const STARTUP_OUTPUT_PREVIEW_LIMIT = 8_192;

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
  kimi: KIMI_PROVIDER,
};

const HOSTED_PTY_TERM = "xterm-256color";
const HOSTED_PTY_COLORTERM = "truecolor";
interface HostedPtyRegistryDeps {
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  getProviderEnv: () => NodeJS.ProcessEnv;
  touchSessionActivity: (sessionId: string) => boolean;
  updateTerminalCwd: (sessionId: string, cwd: string) => boolean;
  // PTY → Session FSM 的翻译副作用（changeSessionState、清理 interrupted approvals、推
  // agent status 等）由 bridge 收口；hosted 与 terminal-ipc 共用同一实现。
  applyPtyStateToSession: (sessionId: string, ptyState: PtySemanticState) => void;
}

interface HostedPtyStartOptions {
  sessionId: string;
  kind: "agent";
  provider: ProviderId;
  cwd: string;
  args: string[];
  permissionMode?: string;
  nativeSessionId?: string;
  hook?: ProviderHookContext;
  cols: number;
  rows: number;
}

interface HostedShellStartOptions {
  sessionId: string;
  kind: "terminal";
  cwd: string;
  shell?: string;
  cols: number;
  rows: number;
}

interface HostedPtySession {
  kind: "agent" | "terminal";
  provider?: ProviderId;
  nativeSessionId?: string;
  child: IPty;
  renderSequencer: PtyRenderSequencer;
  xtermHistoryCompat: CodexXtermHistoryCompat | null;
  xtermHistoryCompatReported: boolean;
  synchronizedOutput: PtySynchronizedOutputCoalescer;
  idleTimer: NodeJS.Timeout;
  startedAt: number;
  lastOutputTime: number;
  currentState: PtySemanticState;
  ptyStateSeq: number;
  semanticTextTail: string;
  startupOutput: string;
  textApprovalWaitActive: boolean;
}

export function buildHostedPtyArgs(provider: ProviderId, resumeSessionId?: string): string[] {
  if (!resumeSessionId) return [];
  if (provider === "codex") return ["resume", resumeSessionId];
  if (provider === "kimi") return ["--session", resumeSessionId];
  return ["--resume", resumeSessionId];
}

export function normalizeHostedPtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    normalized[key] = value;
  }

  delete normalized.NO_COLOR;
  if (normalized.CLICOLOR === "0") {
    delete normalized.CLICOLOR;
  }

  normalized.TERM = HOSTED_PTY_TERM;
  normalized.COLORTERM = HOSTED_PTY_COLORTERM;
  normalized.CLICOLOR = "1";
  return normalized;
}

function appendStartupOutput(current: string, data: string): string {
  const next = current + data;
  return next.length > STARTUP_OUTPUT_PREVIEW_LIMIT
    ? next.slice(-STARTUP_OUTPUT_PREVIEW_LIMIT)
    : next;
}

export class HostedPtyRegistry {
  private sessions = new Map<string, HostedPtySession>();

  constructor(private readonly deps: HostedPtyRegistryDeps) {}

  start(options: HostedPtyStartOptions | HostedShellStartOptions): number {
    const kind = options.kind;
    const { cols, rows } = options;
    const command =
      options.kind === "terminal"
        ? {
            command: options.shell ?? this.deps.getProviderEnv().SHELL ?? "/bin/sh",
            args: [],
            env: this.deps.getProviderEnv(),
          }
        : PROVIDERS[options.provider].buildTerminalCommand(
            {
              args: options.args,
              permissionMode: options.permissionMode,
              hook: options.hook,
            },
            this.deps.getProviderEnv(),
          );
    const env = normalizeHostedPtyEnv(command.env);
    const child = pty.spawn(command.command, command.args, {
      name: HOSTED_PTY_TERM,
      cols,
      rows,
      cwd: options.cwd,
      env,
    });

    const renderSequencer = new PtyRenderSequencer({ cols, rows });

    const hosted: HostedPtySession = {
      kind,
      ...(options.kind === "terminal" ? {} : { provider: options.provider }),
      ...(options.kind === "terminal" || !options.nativeSessionId
        ? {}
        : { nativeSessionId: options.nativeSessionId }),
      child,
      renderSequencer,
      xtermHistoryCompat: createCodexXtermHistoryCompat(
        options.kind === "terminal" ? null : options.provider,
        rows,
        this.deps.getProviderEnv(),
      ),
      xtermHistoryCompatReported: false,
      synchronizedOutput: new PtySynchronizedOutputCoalescer({
        // The callback cannot run until child.onData is registered below, after hosted is fully
        // initialized. Capturing hosted keeps the canonical headless/remote sequence in one place.
        emit: (data) => this.emitRenderData(options.sessionId, hosted, data),
        onOverflow: (event) => {
          serviceLogger.warn(
            { sessionId: options.sessionId, ...event },
            "PTY synchronized-output transaction exceeded buffer limit; streaming remainder",
          );
        },
      }),
      idleTimer: setInterval(() => this.checkIdle(options.sessionId), IDLE_CHECK_INTERVAL_MS),
      startedAt: Date.now(),
      lastOutputTime: 0,
      currentState: "turn_complete",
      ptyStateSeq: 0,
      semanticTextTail: "",
      startupOutput: "",
      textApprovalWaitActive: false,
    };
    this.sessions.set(options.sessionId, hosted);

    child.onData((data) => this.handleData(options.sessionId, data));
    child.onExit(({ exitCode, signal }) => {
      const code = signal ? 128 + signal : exitCode;
      const current = this.sessions.get(options.sessionId);
      const uptimeMs = current ? Date.now() - current.startedAt : undefined;
      const startupErrorTail =
        code !== 0 && current ? sanitizeProviderErrorTail(current.startupOutput) : "";
      const activeWriter =
        code !== 0 && current?.provider === "codex"
          ? classifyCodexActiveWriterError(current.startupOutput)
          : null;
      const activeWriterThreadId =
        activeWriter?.threadId ??
        (current?.provider === "codex" &&
        current.nativeSessionId &&
        /already has an active writer/i.test(current.startupOutput)
          ? current.nativeSessionId
          : null);
      if (activeWriterThreadId) {
        const writer = findCodexActiveWriter(activeWriterThreadId, this.deps.getProviderEnv());
        this.deps.relayConnection.sendRaw(
          serializeControl({
            type: "session_runtime_error",
            sessionId: options.sessionId,
            errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
            error: codexActiveWriterMessage(writer?.pid),
            ...(writer ? { activeWriterPid: writer.pid } : {}),
          }),
        );
      }
      serviceLogger.info(
        {
          sessionId: options.sessionId,
          code,
          ...(uptimeMs !== undefined ? { uptimeMs } : {}),
          ...(startupErrorTail
            ? {
                startupOutputChars: current?.startupOutput.length,
                startupErrorTail,
              }
            : {}),
        },
        "Hosted PTY exited",
      );
      this.close(options.sessionId, { kill: false, notify: true });
    });

    serviceLogger.info(
      {
        sessionId: options.sessionId,
        kind,
        ...(options.kind !== "terminal" ? { provider: options.provider } : {}),
        command: command.command,
        pid: child.pid,
        cwd: options.cwd,
        cols,
        rows,
      },
      "Hosted PTY started",
    );
    return child.pid;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  write(sessionId: string, data: string, traceId?: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    if (hosted.kind === "agent") {
      this.updateSemanticStateOnInput(sessionId, hosted, data);
    }
    hosted.child.write(data);
    serviceLogger.debug(
      { sessionId, traceId, bytes: data.length },
      "Raw PTY input written to hosted PTY",
    );
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    this.flushPendingRenderData(hosted);
    hosted.xtermHistoryCompat?.setTerminalRows(rows);
    const outputSeq = hosted.renderSequencer.resize(cols, rows);
    if (outputSeq === null) return false;
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "terminal_resize",
        sessionId,
        cols,
        rows,
        outputSeq,
      }),
    );
    hosted.child.resize(cols, rows);
    serviceLogger.info({ sessionId, cols, rows }, "Hosted PTY resized");
    return true;
  }

  snapshot(sessionId: string, requestId: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    hosted.renderSequencer.captureSnapshot((snapshot) => {
      if (this.sessions.get(sessionId) !== hosted) return;
      this.deps.relayConnection.sendRaw(
        serializeControl({
          type: "session_snapshot",
          sessionId,
          ...snapshot,
          requestId,
        }),
      );
      serviceLogger.info(
        {
          sessionId,
          cols: snapshot.cols,
          rows: snapshot.rows,
          bytes: snapshot.data.length,
          outputSeq: snapshot.outputSeq,
        },
        "Hosted PTY snapshot sent",
      );
    });
    return true;
  }

  terminate(sessionId: string): boolean {
    return this.close(sessionId, { kill: true, notify: true });
  }

  abortStartup(sessionId: string): boolean {
    return this.close(sessionId, { kill: true, notify: false });
  }

  destroyAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      if (this.close(sessionId, { kill: true, notify: false })) {
        // Hosted node-pty runtimes cannot reconnect to a replacement daemon. Remove their
        // persisted SessionManager record while the old daemon still has an authenticated child
        // handle; leaving it behind would make the new daemon mistake it for a handover candidate.
        this.deps.sessionManager.terminateSession(sessionId);
      }
    }
  }

  private handleData(sessionId: string, data: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    hosted.lastOutputTime = Date.now();
    hosted.startupOutput = appendStartupOutput(hosted.startupOutput, data);
    this.deps.touchSessionActivity(sessionId);
    const previousRewriteCount = hosted.xtermHistoryCompat?.stats.rewrittenTransactions ?? 0;
    const renderData = hosted.xtermHistoryCompat?.push(data) ?? data;
    hosted.synchronizedOutput.push(renderData);
    this.reportXtermHistoryCompatRewrite(sessionId, hosted, previousRewriteCount);

    const oscSequences = extractOscSequences(data);
    const cwd = extractOscWorkingDirectory(data);
    const session = this.deps.sessionManager.getSession(sessionId);
    const oscSignal = extractOscSignals(data, session?.provider);
    if (oscSignal?.title) {
      this.sendTerminalTitle(sessionId, oscSignal.title);
    }
    if (hosted.kind === "terminal" && cwd) {
      this.deps.updateTerminalCwd(sessionId, cwd);
    }
    if (hosted.kind === "terminal") return;

    hosted.semanticTextTail = appendPtySemanticTextTail(hosted.semanticTextTail, data);
    const textSignal = oscSignal
      ? null
      : extractTextSignals(hosted.semanticTextTail, session?.provider);
    const signal = oscSignal ?? textSignal;
    if (textSignal?.state === "approval_wait") {
      hosted.textApprovalWaitActive = true;
      hosted.semanticTextTail = "";
    }
    if (oscSequences.length > 0) {
      serviceLogger.debug(
        {
          sessionId,
          oscSequences,
          signal,
        },
        "Hosted PTY OSC sequences parsed",
      );
    }
    if (signal?.title && signal.title !== oscSignal?.title) {
      this.sendTerminalTitle(sessionId, signal.title);
    }

    // 语义决策走统一 common/pty-semantic-machine；hosted 端在 emit 时多做两件事：
    // 1. 把 PTY semantic state 翻译成 session JSON FSM 转换；2. turn_complete 时触发 onTurnComplete 回调。
    const decision = decidePtySemanticTransition({
      currentState: hosted.currentState,
      signal: signal ?? null,
      sessionStateIsWaitingApproval: session?.state === SessionState.WAITING_APPROVAL,
      allowTitleOnlyApprovalRelease: !hosted.textApprovalWaitActive,
    });
    hosted.currentState = decision.nextState;
    if (decision.nextState !== "approval_wait") {
      hosted.textApprovalWaitActive = false;
    }
    if (!decision.emit) return;

    this.sendPtyState(sessionId, decision.nextState, decision.meta, hosted);
    this.deps.applyPtyStateToSession(sessionId, decision.nextState);
  }

  private updateSemanticStateOnInput(
    sessionId: string,
    hosted: HostedPtySession,
    data: string,
  ): void {
    if (
      hosted.textApprovalWaitActive &&
      hosted.currentState === "approval_wait" &&
      shouldReleaseTextApprovalOnInput(data)
    ) {
      hosted.textApprovalWaitActive = false;
      hosted.currentState = "working";
      this.sendPtyState(sessionId, "working", undefined, hosted);
      this.deps.applyPtyStateToSession(sessionId, "working");
      return;
    }

    if (!shouldStartPtyTurnOnInput(hosted.currentState, data)) return;
    hosted.currentState = "working";
    this.sendPtyState(sessionId, "working", undefined, hosted);
    this.deps.applyPtyStateToSession(sessionId, "working");
  }

  private checkIdle(sessionId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    if (hosted.kind === "terminal") return;
    if (hosted.lastOutputTime === 0 || Date.now() - hosted.lastOutputTime <= IDLE_THRESHOLD_MS) {
      return;
    }
    hosted.lastOutputTime = 0;
    if (hosted.currentState !== "working") return;
    hosted.currentState = "turn_complete";
    this.sendPtyState(sessionId, "turn_complete", undefined, hosted);
    this.deps.applyPtyStateToSession(sessionId, "turn_complete");
  }

  private sendPtyState(
    sessionId: string,
    state: PtySemanticState,
    meta: { title?: string; tool?: string } | undefined,
    hosted: HostedPtySession,
  ): void {
    const seq = ++hosted.ptyStateSeq;
    const payload = {
      state,
      seq,
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
      ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
    };
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "pty_state",
        sessionId,
        payload,
      }),
    );
    const logPayload = { sessionId, ...payload };
    if (state === "approval_wait" || state === "turn_complete") {
      serviceLogger.info(logPayload, "Hosted PTY semantic event pushed");
    } else {
      serviceLogger.debug(logPayload, "Hosted PTY semantic event pushed");
    }
  }

  private sendTerminalTitle(sessionId: string, title: string): void {
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "terminal_title",
        sessionId,
        title,
      }),
    );
  }

  private sendBinary(sessionId: string, data: Buffer, outputSeq: number): void {
    this.deps.relayConnection.sendBinary(encodeBinaryFrame(sessionId, outputSeq, data));
  }

  private emitRenderData(sessionId: string, hosted: HostedPtySession, data: string): void {
    if (!data) return;
    const outputSeq = hosted.renderSequencer.write(data);
    if (outputSeq === null) return;
    this.sendBinary(sessionId, Buffer.from(data, "utf-8"), outputSeq);
  }

  private flushPendingRenderData(hosted: HostedPtySession): void {
    hosted.synchronizedOutput.push(hosted.xtermHistoryCompat?.flush() ?? "");
    hosted.synchronizedOutput.flush();
  }

  private disposePendingRenderData(hosted: HostedPtySession): void {
    hosted.synchronizedOutput.push(hosted.xtermHistoryCompat?.flush() ?? "");
    hosted.synchronizedOutput.dispose();
  }

  private reportXtermHistoryCompatRewrite(
    sessionId: string,
    hosted: HostedPtySession,
    previousRewriteCount: number,
  ): void {
    const stats = hosted.xtermHistoryCompat?.stats;
    if (!stats || stats.rewrittenTransactions === previousRewriteCount) return;
    const payload = {
      sessionId,
      rewrittenTransactions: stats.rewrittenTransactions,
      preservedRows: stats.preservedRows,
    };
    if (!hosted.xtermHistoryCompatReported) {
      hosted.xtermHistoryCompatReported = true;
      serviceLogger.info(payload, "Codex xterm history compatibility activated");
    } else {
      serviceLogger.debug(payload, "Codex xterm history transaction rewritten");
    }
  }

  private close(sessionId: string, options: { kill: boolean; notify: boolean }): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    clearInterval(hosted.idleTimer);
    this.disposePendingRenderData(hosted);
    if (options.kill) {
      try {
        hosted.child.kill();
      } catch {
        // PTY may already have exited.
      }
    }
    hosted.renderSequencer.dispose();
    if (options.notify) {
      this.sendPtyState(sessionId, "turn_complete", undefined, hosted);
      this.deps.sessionManager.terminateSession(sessionId);
    }
    this.sessions.delete(sessionId);
    return true;
  }
}
