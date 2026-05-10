import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { SessionState, encodeBinaryFrame } from "@dev-anywhere/shared";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { serviceLogger } from "../common/logger.js";
import {
  extractOscSequences,
  extractOscSignals,
  type PtySemanticState,
} from "../common/osc-extractor.js";
import {
  shouldReleaseApprovalWait,
  stateAfterApprovalRelease,
} from "../common/pty-approval-state.js";
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

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

const HOSTED_PTY_TERM = "xterm-256color";
const HOSTED_PTY_COLORTERM = "truecolor";

interface HostedPtyRegistryDeps {
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  getProviderEnv: () => NodeJS.ProcessEnv;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  touchSessionActivity: (sessionId: string) => boolean;
  onTurnComplete: (sessionId: string) => void;
  onSessionClosed: (sessionId: string) => void;
}

interface HostedPtyStartOptions {
  sessionId: string;
  provider: ProviderId;
  cwd: string;
  args: string[];
  permissionMode?: string;
  hook: ProviderHookContext;
  cols?: number;
  rows?: number;
}

interface HostedPtySession {
  child: IPty;
  terminal: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: SerializeAddon;
  idleTimer: NodeJS.Timeout;
  lastOutputTime: number;
  currentState: PtySemanticState;
  outputSeq: number;
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

export class HostedPtyRegistry {
  private sessions = new Map<string, HostedPtySession>();

  constructor(private readonly deps: HostedPtyRegistryDeps) {}

  start(options: HostedPtyStartOptions): number {
    const provider = PROVIDERS[options.provider];
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const command = provider.buildTerminalCommand(
      { args: options.args, permissionMode: options.permissionMode, hook: options.hook },
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
      child,
      terminal,
      serializeAddon,
      idleTimer: setInterval(() => this.checkIdle(options.sessionId), IDLE_CHECK_INTERVAL_MS),
      lastOutputTime: 0,
      currentState: "turn_complete",
      outputSeq: 0,
    };
    this.sessions.set(options.sessionId, hosted);

    child.onData((data) => this.handleData(options.sessionId, data));
    child.onExit(({ exitCode, signal }) => {
      const code = signal ? 128 + signal : exitCode;
      serviceLogger.info({ sessionId: options.sessionId, code }, "Hosted PTY exited");
      this.close(options.sessionId, { kill: false, notify: true });
    });

    serviceLogger.info(
      {
        sessionId: options.sessionId,
        provider: options.provider,
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

  write(sessionId: string, data: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    hosted.child.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    hosted.child.resize(cols, rows);
    hosted.terminal.resize(cols, rows);
    this.deps.relayConnection.sendRaw(
      JSON.stringify({ type: "terminal_resize", sessionId, cols, rows }),
    );
    serviceLogger.info({ sessionId, cols, rows }, "Hosted PTY resized");
    return true;
  }

  snapshot(sessionId: string, requestId?: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return false;
    const data = hosted.serializeAddon.serialize();
    this.deps.relayConnection.sendRaw(
      JSON.stringify({
        type: "session_snapshot",
        sessionId,
        cols: hosted.terminal.cols,
        rows: hosted.terminal.rows,
        data,
        outputSeq: hosted.outputSeq,
        requestId,
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
    hosted.terminal.write(data);
    this.deps.touchSessionActivity(sessionId);
    this.sendBinary(sessionId, Buffer.from(data, "utf-8"), hosted.outputSeq);

    const oscSequences = extractOscSequences(data);
    const session = this.deps.sessionManager.getSession(sessionId);
    const signal = extractOscSignals(data, session?.provider);
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
    if (signal?.title) {
      this.sendTerminalTitle(sessionId, signal.title);
    }
    if (signal?.state === "approval_wait") {
      hosted.currentState = "approval_wait";
      this.deps.changeSessionState(sessionId, SessionState.WAITING_APPROVAL);
      this.sendPtyState(sessionId, "approval_wait", { title: signal?.title, tool: signal?.tool });
      return;
    }
    if (
      shouldReleaseApprovalWait({
        currentState: hosted.currentState,
        signalState: signal?.state,
      })
    ) {
      const nextState = stateAfterApprovalRelease(signal?.state);
      hosted.currentState = nextState;
      if (nextState === "turn_complete") {
        this.deps.onTurnComplete(sessionId);
        this.deps.changeSessionState(sessionId, SessionState.IDLE);
      } else {
        this.deps.changeSessionState(sessionId, SessionState.WORKING);
      }
      this.sendPtyState(sessionId, nextState, { title: signal?.title, tool: signal?.tool });
      return;
    }
    if (
      (session?.state === SessionState.WAITING_APPROVAL ||
        hosted.currentState === "approval_wait") &&
      signal?.state !== "turn_complete"
    ) {
      hosted.currentState = "approval_wait";
      this.sendPtyState(sessionId, "approval_wait", { title: signal?.title, tool: signal?.tool });
      return;
    }
    if (signal && signal.state !== "working") {
      hosted.currentState = signal.state;
      if (signal.state === "turn_complete") {
        this.deps.onTurnComplete(sessionId);
        this.deps.changeSessionState(sessionId, SessionState.IDLE);
      }
      this.sendPtyState(sessionId, signal.state, { title: signal.title, tool: signal.tool });
      return;
    }
    if (hosted.currentState !== "working") {
      hosted.currentState = "working";
      this.deps.changeSessionState(sessionId, SessionState.WORKING);
      this.sendPtyState(sessionId, "working");
    }
  }

  private checkIdle(sessionId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    if (hosted.lastOutputTime === 0 || Date.now() - hosted.lastOutputTime <= IDLE_THRESHOLD_MS) {
      return;
    }
    hosted.lastOutputTime = 0;
    if (hosted.currentState !== "working") return;
    hosted.currentState = "turn_complete";
    this.deps.onTurnComplete(sessionId);
    this.deps.changeSessionState(sessionId, SessionState.IDLE);
    this.sendPtyState(sessionId, "turn_complete");
  }

  private sendPtyState(
    sessionId: string,
    state: PtySemanticState,
    meta?: { title?: string; tool?: string },
  ): void {
    const payload = {
      state,
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
      ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
    };
    this.deps.relayConnection.sendRaw(
      JSON.stringify({
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
      JSON.stringify({
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
    this.sessions.delete(sessionId);
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
      this.sendPtyState(sessionId, "turn_complete");
      this.deps.sessionManager.terminateSession(sessionId);
      this.deps.onSessionClosed(sessionId);
    }
    return true;
  }
}
