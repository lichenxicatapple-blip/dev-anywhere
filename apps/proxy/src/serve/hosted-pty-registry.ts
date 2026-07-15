import * as pty from "node-pty";
import type { IPty } from "node-pty";
import {
  SessionState,
  encodeBinaryFrame,
  serializeControl,
  type PtySemanticState,
} from "@dev-anywhere/shared";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { serviceLogger } from "../common/logger.js";
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
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  type ProviderAdapter,
  type ProviderHookContext,
  type ProviderId,
} from "../providers/index.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const IDLE_CHECK_INTERVAL_MS = 3_000;
const IDLE_THRESHOLD_MS = 3_000;
const STARTUP_EXIT_DIAGNOSTIC_WINDOW_MS = 10_000;
const STARTUP_OUTPUT_PREVIEW_LIMIT = 8_192;

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

const HOSTED_PTY_TERM = "xterm-256color";
const HOSTED_PTY_COLORTERM = "truecolor";
const ANSI_OSC_RE = new RegExp(String.raw`\x1b\][^\x07]*(?:\x07|\x1b\\)`, "g");
const ANSI_CSI_RE = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_CHARSET_RE = new RegExp(String.raw`\x1b[()][A-Za-z0-9]`, "g");

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
  kind?: "agent";
  provider: ProviderId;
  cwd: string;
  args: string[];
  permissionMode?: string;
  hook: ProviderHookContext;
  cols?: number;
  rows?: number;
}

interface HostedShellStartOptions {
  sessionId: string;
  kind: "terminal";
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

interface HostedPtySession {
  kind: "agent" | "terminal";
  child: IPty;
  terminal: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: SerializeAddon;
  idleTimer: NodeJS.Timeout;
  startedAt: number;
  lastOutputTime: number;
  currentState: PtySemanticState;
  outputSeq: number;
  ptyStateSeq: number;
  semanticTextTail: string;
  startupOutput: string;
  textApprovalWaitActive: boolean;
}

export function buildHostedPtyArgs(provider: ProviderId, resumeSessionId?: string): string[] {
  if (!resumeSessionId) return [];
  return provider === "codex" ? ["resume", resumeSessionId] : ["--resume", resumeSessionId];
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
  if (current.length >= STARTUP_OUTPUT_PREVIEW_LIMIT) return current;
  const next = current + data;
  return next.length > STARTUP_OUTPUT_PREVIEW_LIMIT
    ? next.slice(0, STARTUP_OUTPUT_PREVIEW_LIMIT)
    : next;
}

function cleanPtyOutputPreview(output: string): string {
  return output
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_CHARSET_RE, "")
    .replace(/\r/g, "\n")
    .replace(/[^\t\n\x20-\x7e\u0080-\uffff]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class HostedPtyRegistry {
  private sessions = new Map<string, HostedPtySession>();

  constructor(private readonly deps: HostedPtyRegistryDeps) {}

  start(options: HostedPtyStartOptions | HostedShellStartOptions): number {
    const kind = options.kind ?? "agent";
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
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

    const terminal = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    void import("@xterm/addon-unicode-graphemes")
      .then(({ UnicodeGraphemesAddon }) => terminal.loadAddon(new UnicodeGraphemesAddon()))
      .catch((err) => {
        serviceLogger.warn(
          { sessionId: options.sessionId, error: String(err) },
          "Unicode addon unavailable",
        );
      });

    const hosted: HostedPtySession = {
      kind,
      child,
      terminal,
      serializeAddon,
      idleTimer: setInterval(() => this.checkIdle(options.sessionId), IDLE_CHECK_INTERVAL_MS),
      startedAt: Date.now(),
      lastOutputTime: 0,
      currentState: "turn_complete",
      outputSeq: 0,
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
      const outputPreview = current ? cleanPtyOutputPreview(current.startupOutput) : "";
      const shouldIncludeStartupOutput =
        current &&
        uptimeMs !== undefined &&
        uptimeMs <= STARTUP_EXIT_DIAGNOSTIC_WINDOW_MS &&
        outputPreview.length > 0;
      serviceLogger.info(
        {
          sessionId: options.sessionId,
          code,
          ...(uptimeMs !== undefined ? { uptimeMs } : {}),
          ...(shouldIncludeStartupOutput
            ? {
                startupOutputChars: current.startupOutput.length,
                startupOutputPreview: outputPreview,
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
    hosted.child.resize(cols, rows);
    hosted.terminal.resize(cols, rows);
    this.deps.relayConnection.sendRaw(
      serializeControl({ type: "terminal_resize", sessionId, cols, rows }),
    );
    serviceLogger.info({ sessionId, cols, rows }, "Hosted PTY resized");
    return true;
  }

  snapshot(sessionId: string, requestId?: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    const data = hosted.serializeAddon.serialize();
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "session_snapshot",
        sessionId,
        cols: hosted.terminal.cols,
        rows: hosted.terminal.rows,
        data,
        outputSeq: hosted.outputSeq,
        ...(requestId !== undefined ? { requestId } : {}),
      }),
    );
    serviceLogger.info(
      { sessionId, cols: hosted.terminal.cols, rows: hosted.terminal.rows, bytes: data.length },
      "Hosted PTY snapshot sent",
    );
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
      this.close(sessionId, { kill: true, notify: false });
    }
  }

  private handleData(sessionId: string, data: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    hosted.lastOutputTime = Date.now();
    hosted.outputSeq += 1;
    hosted.startupOutput = appendStartupOutput(hosted.startupOutput, data);
    hosted.terminal.write(data);
    this.deps.touchSessionActivity(sessionId);
    this.sendBinary(sessionId, Buffer.from(data, "utf-8"), hosted.outputSeq);

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
    meta?: { title?: string; tool?: string },
    hosted: HostedPtySession | undefined = this.sessions.get(sessionId),
  ): void {
    const seq = hosted ? ++hosted.ptyStateSeq : undefined;
    const payload = {
      state,
      ...(seq !== undefined ? { seq } : {}),
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

  private close(sessionId: string, options: { kill: boolean; notify: boolean }): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    clearInterval(hosted.idleTimer);
    if (options.kill) {
      try {
        hosted.child.kill();
      } catch {
        // PTY may already have exited.
      }
    }
    hosted.terminal.dispose();
    if (options.notify) {
      this.sendPtyState(sessionId, "turn_complete", undefined, hosted);
      this.deps.sessionManager.terminateSession(sessionId);
    }
    this.sessions.delete(sessionId);
    return true;
  }
}
