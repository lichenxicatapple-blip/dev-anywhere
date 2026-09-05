import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { ControlErrorCode, type PtySemanticState } from "@dev-anywhere/shared";
import { defaultShell, normalizeProcessEnvironment } from "./executable.js";
import { prepareCommandLaunch } from "./command-launch.js";
import { terminalLogger as log } from "./logger.js";
import {
  classifyCodexActiveWriterError,
  sanitizeProviderErrorTail,
} from "./codex-session-conflict.js";
import {
  appendPtySemanticTextTail,
  extractOscSignals,
  extractOscWorkingDirectory,
  extractTextSignals,
} from "./osc-extractor.js";
import { shouldReleaseTextApprovalOnInput } from "./pty-approval-state.js";
import { decidePtySemanticTransition, shouldStartPtyTurnOnInput } from "./pty-semantic-machine.js";
import { PtyRenderSequencer, type PtySnapshot } from "./pty-render-sequencer.js";
import {
  createCodexXtermHistoryCompat,
  type CodexXtermHistoryCompat,
} from "./codex-xterm-history-compat.js";
import { PtySynchronizedOutputCoalescer } from "./pty-synchronized-output-coalescer.js";
import { createIdleChecker, type IdleChecker } from "./pty-idle-checker.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  KIMI_PROVIDER,
  type ProviderAdapter,
  type ProviderHookContext,
  type ProviderId,
} from "../providers/index.js";

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
  kimi: KIMI_PROVIDER,
};

export interface PtyRuntimeExit {
  exitCode: number;
  errorTail?: string;
  runtimeError?:
    | { errorCode: typeof ControlErrorCode.SESSION_ALREADY_ACTIVE; nativeSessionId: string }
    | { errorCode: typeof ControlErrorCode.PROCESS_START_FAILED; error: string };
}

interface PtyRuntimeBaseOptions {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type PtyRuntimeOptions = PtyRuntimeBaseOptions &
  (
    | { kind: "terminal"; shell?: string }
    | {
        kind: "agent";
        provider: ProviderId;
        args: string[];
        permissionMode?: string;
        nativeSessionId?: string;
        hook?: ProviderHookContext;
      }
  );

export interface PtyRuntimeEvents {
  output: (data: string, outputSeq: number) => void;
  resize: (cols: number, rows: number, outputSeq: number) => void;
  title: (title: string) => void;
  cwd: (cwd: string) => void;
  semantic: (
    state: PtySemanticState,
    seq: number,
    meta?: { title?: string; tool?: string },
  ) => void;
  exit: (event: PtyRuntimeExit) => void;
}

export function buildHostedPtyArgs(provider: ProviderId, resumeSessionId?: string): string[] {
  if (!resumeSessionId) return [];
  if (provider === "codex") return ["resume", resumeSessionId];
  if (provider === "kimi") return ["--session", resumeSessionId];
  return ["--resume", resumeSessionId];
}

export function normalizePtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalizeProcessEnvironment(env))) {
    if (value !== undefined) result[key] = value;
  }
  delete result.NO_COLOR;
  if (result.CLICOLOR === "0") delete result.CLICOLOR;
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  result.CLICOLOR = "1";
  return result;
}

/** Owns one PTY and its canonical screen independently of any Proxy connection. */
export class PtyRuntime {
  private child: IPty | null = null;
  private readonly renderSequencer: PtyRenderSequencer;
  private readonly synchronizedOutput: PtySynchronizedOutputCoalescer;
  private readonly xtermHistoryCompat: CodexXtermHistoryCompat | null;
  private readonly idleChecker: IdleChecker;
  private closed = false;
  private started = false;
  private lastOutputTime = 0;
  private currentState: PtySemanticState = "turn_complete";
  private stateSeq = 0;
  private semanticTextTail = "";
  private outputTail = "";
  private textApprovalWaitActive = false;
  private approvalWaiting = false;
  private compatReported = false;

  constructor(
    private readonly options: PtyRuntimeOptions,
    private readonly events: PtyRuntimeEvents,
  ) {
    this.renderSequencer = new PtyRenderSequencer(options);
    this.xtermHistoryCompat = createCodexXtermHistoryCompat(
      options.kind === "agent" ? options.provider : null,
      options.rows,
      options.env,
    );
    this.synchronizedOutput = new PtySynchronizedOutputCoalescer({
      emit: (data) => {
        const seq = this.renderSequencer.write(data);
        if (seq !== null) this.events.output(data, seq);
      },
      onOverflow: (event) =>
        log.warn(
          { sessionId: options.sessionId, ...event },
          "PTY synchronized-output transaction exceeded buffer limit; streaming remainder",
        ),
    });
    this.idleChecker = createIdleChecker({
      intervalMs: 3_000,
      thresholdMs: 3_000,
      getLastOutputTime: () => this.lastOutputTime,
      setLastOutputTime: (value) => {
        this.lastOutputTime = value;
      },
      getCurrentState: () => this.currentState,
      onIdle: () => {
        if (this.approvalWaiting) return;
        this.currentState = "turn_complete";
        this.emitSemantic();
      },
    });
  }

  start(): number {
    if (this.started || this.closed)
      throw new Error("PTY runtime has already been started or disposed");
    this.started = true;
    const options = this.options;
    const command =
      options.kind === "terminal"
        ? { command: options.shell ?? defaultShell(options.env), args: [], env: options.env }
        : PROVIDERS[options.provider].buildTerminalCommand(
            {
              args: options.args,
              cwd: options.cwd,
              permissionMode: options.permissionMode,
              hook: options.hook,
            },
            options.env,
          );
    const launch = prepareCommandLaunch(
      command.command,
      command.args,
      command.env,
      process.platform,
      options.cwd,
    );
    let child: IPty;
    try {
      child = pty.spawn(launch.command, launch.ptyArgs ?? launch.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: normalizePtyEnv(launch.env),
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.child = child;
    child.onData((data) => this.handleData(data));
    child.onExit(({ exitCode, signal }) => {
      if (this.closed) return;
      const code = signal ? 128 + signal : exitCode;
      const errorTail = code === 0 ? "" : sanitizeProviderErrorTail(this.outputTail);
      const activeWriter =
        code !== 0 && options.kind === "agent" && options.provider === "codex"
          ? classifyCodexActiveWriterError(this.outputTail)
          : null;
      const nativeSessionId =
        activeWriter?.threadId ??
        (code !== 0 &&
        options.kind === "agent" &&
        options.provider === "codex" &&
        /already has an active writer/i.test(this.outputTail)
          ? options.nativeSessionId
          : undefined);
      const event: PtyRuntimeExit = {
        exitCode: code,
        ...(errorTail ? { errorTail } : {}),
        ...(nativeSessionId
          ? {
              runtimeError: { errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE, nativeSessionId },
            }
          : {}),
      };
      this.flushPendingOutput();
      this.currentState = "turn_complete";
      if (options.kind === "agent") this.emitSemantic();
      this.dispose();
      this.events.exit(event);
    });
    if (options.kind === "agent") this.idleChecker.start();
    log.info(
      {
        sessionId: options.sessionId,
        kind: options.kind,
        pid: child.pid,
        command: command.command,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      },
      "PTY runtime started",
    );
    return child.pid;
  }

  write(data: string): void {
    if (!this.child || this.closed) return;
    if (this.options.kind === "agent") {
      if (
        this.textApprovalWaitActive &&
        this.currentState === "approval_wait" &&
        shouldReleaseTextApprovalOnInput(data)
      ) {
        this.textApprovalWaitActive = false;
        this.currentState = "working";
        this.emitSemantic();
      } else if (shouldStartPtyTurnOnInput(this.currentState, data)) {
        this.currentState = "working";
        this.emitSemantic();
      }
    }
    this.child.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.child || this.closed) return;
    this.flushPendingOutput();
    this.xtermHistoryCompat?.setTerminalRows(rows);
    const seq = this.renderSequencer.resize(cols, rows);
    if (seq === null) return;
    this.events.resize(cols, rows, seq);
    this.child.resize(cols, rows);
  }

  snapshot(callback: (snapshot: PtySnapshot) => void): void {
    if (!this.closed) this.renderSequencer.captureSnapshot(callback);
  }

  setApprovalWaiting(waiting: boolean): void {
    this.approvalWaiting = waiting;
  }

  replaySemanticState(): void {
    if (!this.closed && this.options.kind === "agent") this.emitSemantic();
  }

  terminate(): void {
    if (this.closed) return;
    const child = this.child;
    this.dispose();
    try {
      child?.kill();
    } catch {
      /* The owned child may already have exited. */
    }
  }

  private handleData(data: string): void {
    if (this.closed) return;
    this.lastOutputTime = Date.now();
    this.outputTail = `${this.outputTail}${data}`.slice(-8_192);
    const previousRewrites = this.xtermHistoryCompat?.stats.rewrittenTransactions ?? 0;
    this.synchronizedOutput.push(this.xtermHistoryCompat?.push(data) ?? data);
    const stats = this.xtermHistoryCompat?.stats;
    if (stats && stats.rewrittenTransactions !== previousRewrites) {
      log[this.compatReported ? "debug" : "info"](
        { sessionId: this.options.sessionId, ...stats },
        "Codex xterm history transaction rewritten",
      );
      this.compatReported = true;
    }
    const provider = this.options.kind === "agent" ? this.options.provider : undefined;
    const oscSignal = extractOscSignals(data, provider);
    if (oscSignal?.title) this.events.title(oscSignal.title);
    if (this.options.kind === "terminal") {
      const cwd = extractOscWorkingDirectory(data);
      if (cwd) this.events.cwd(cwd);
      return;
    }
    this.semanticTextTail = appendPtySemanticTextTail(this.semanticTextTail, data);
    const textSignal = oscSignal ? null : extractTextSignals(this.semanticTextTail, provider);
    if (textSignal?.state === "approval_wait") {
      this.textApprovalWaitActive = true;
      this.semanticTextTail = "";
    }
    if (textSignal?.title) this.events.title(textSignal.title);
    const decision = decidePtySemanticTransition({
      currentState: this.currentState,
      signal: oscSignal ?? textSignal,
      sessionStateIsWaitingApproval: this.approvalWaiting,
      allowTitleOnlyApprovalRelease: !this.textApprovalWaitActive,
    });
    this.currentState = decision.nextState;
    if (decision.nextState !== "approval_wait") this.textApprovalWaitActive = false;
    if (decision.emit) this.emitSemantic(decision.meta);
  }

  private emitSemantic(meta?: { title?: string; tool?: string }): void {
    this.events.semantic(this.currentState, ++this.stateSeq, meta);
  }

  private flushPendingOutput(): void {
    this.synchronizedOutput.push(this.xtermHistoryCompat?.flush() ?? "");
    this.synchronizedOutput.flush();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.idleChecker.stop();
    this.synchronizedOutput.push(this.xtermHistoryCompat?.flush() ?? "");
    this.synchronizedOutput.dispose();
    this.renderSequencer.dispose();
    this.child = null;
  }
}
