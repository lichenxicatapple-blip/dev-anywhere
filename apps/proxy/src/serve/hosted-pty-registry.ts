import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { SessionState } from "@dev-anywhere/shared";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { serviceLogger } from "../common/logger.js";
import { extractOscSignals, type PtySemanticState } from "../common/osc-extractor.js";
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

interface HostedPtyRegistryDeps {
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  onSessionClosed: (sessionId: string) => void;
}

interface HostedPtyStartOptions {
  sessionId: string;
  provider: ProviderId;
  cwd: string;
  args: string[];
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
}

export function buildHostedPtyArgs(provider: ProviderId, resumeSessionId?: string): string[] {
  if (!resumeSessionId) return [];
  return provider === "codex" ? ["resume", resumeSessionId] : ["--resume", resumeSessionId];
}

export class HostedPtyRegistry {
  private sessions = new Map<string, HostedPtySession>();

  constructor(private readonly deps: HostedPtyRegistryDeps) {}

  start(options: HostedPtyStartOptions): number {
    const provider = PROVIDERS[options.provider];
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const command = provider.buildTerminalCommand(
      { args: options.args, hook: options.hook },
      process.env,
    );
    const child = pty.spawn(command.command, command.args, {
      name: process.env.TERM ?? "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: command.env as Record<string, string>,
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
    hosted.terminal.write(data);
    this.sendBinary(sessionId, Buffer.from(data, "utf-8"));

    if (hosted.currentState !== "working") {
      hosted.currentState = "working";
      this.sendPtyState(sessionId, "working");
      this.deps.changeSessionState(sessionId, SessionState.WORKING);
    }

    const signal = extractOscSignals(data);
    if (signal?.title) {
      this.sendTerminalTitle(sessionId, signal.title);
    }
    if (signal && signal.state !== "working") {
      hosted.currentState = signal.state;
      this.sendPtyState(sessionId, signal.state, { title: signal.title, tool: signal.tool });
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
    this.sendPtyState(sessionId, "turn_complete");
    this.deps.changeSessionState(sessionId, SessionState.IDLE);
  }

  private sendPtyState(
    sessionId: string,
    state: PtySemanticState,
    meta?: { title?: string; tool?: string },
  ): void {
    this.deps.relayConnection.sendRaw(
      JSON.stringify({
        type: "pty_state",
        sessionId,
        payload: {
          state,
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
        },
      }),
    );
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

  private sendBinary(sessionId: string, data: Buffer): void {
    const sessionIdBuf = Buffer.from(sessionId, "utf-8");
    const frame = Buffer.alloc(1 + sessionIdBuf.length + data.length);
    frame[0] = sessionIdBuf.length;
    sessionIdBuf.copy(frame, 1);
    data.copy(frame, 1 + sessionIdBuf.length);
    this.deps.relayConnection.sendBinary(frame);
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
