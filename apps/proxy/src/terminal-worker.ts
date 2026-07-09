import * as pty from "node-pty";
import type { IPty } from "node-pty";
import pkg from "@xterm/headless";
const { Terminal: HeadlessTerminal } = pkg;
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { extractOscSignals } from "./common/osc-extractor.js";
import { terminalLogger as log } from "./common/logger.js";
import { SOCK_PATH, STOPPED_PATH } from "./common/paths.js";
import {
  createIpcReader,
  encodeBinaryIpcFrame,
  serializeIpc,
  type IpcMessage,
} from "./ipc/ipc-protocol.js";
import { parseTerminalWorkerCliArgs } from "./terminal-worker-args.js";
import { ensureService, tryConnect, waitForMessage } from "./terminal/serve-bootstrap.js";
import { swapServeSocket } from "./terminal/serve-socket-swap.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5_000;

function normalizeTerminalWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) normalized[key] = value;
  }
  delete normalized.NO_COLOR;
  if (normalized.CLICOLOR === "0") delete normalized.CLICOLOR;
  normalized.TERM = "xterm-256color";
  normalized.COLORTERM = "truecolor";
  normalized.CLICOLOR = "1";
  return normalized;
}

class ShellTerminalWorker {
  private socket: Socket | null = null;
  private child: IPty | null = null;
  private readonly terminal = new HeadlessTerminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    scrollback: 5000,
    allowProposedApi: true,
  });
  private readonly serializeAddon = new SerializeAddon();
  private outputSeq = 0;
  private exiting = false;
  private reconnecting = false;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly name: string,
  ) {
    this.terminal.loadAddon(this.serializeAddon);
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
  }

  async run(): Promise<void> {
    this.socket = await ensureService();
    this.setupSocketHandlers(this.socket);
    await this.registerWithServe();
    this.startPty();

    process.on("SIGTERM", () => this.shutdown(143));
    process.on("SIGINT", () => this.shutdown(130));
  }

  private async registerWithServe(): Promise<void> {
    if (!this.socket?.writable) throw new Error("Serve socket is not writable");
    const responsePromise = waitForMessage(this.socket, "session_create_response");
    this.socket.write(
      serializeIpc({
        type: "session_create_request",
        mode: "pty",
        provider: "claude",
        cwd: this.cwd,
        pid: process.pid,
        sessionId: this.sessionId,
        name: this.name,
        kind: "terminal",
      }),
    );
    const response = await responsePromise;
    if (response.error) throw new Error(`Failed to register terminal worker: ${response.error}`);
    this.socket.write(
      serializeIpc({ type: "pty_register", sessionId: this.sessionId, pid: process.pid }),
    );
    log.info({ sessionId: this.sessionId }, "Terminal worker registered with serve");
  }

  private startPty(): void {
    if (this.child) return;
    const shell = process.env.SHELL ?? "/bin/sh";
    const child = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cwd: this.cwd,
      env: normalizeTerminalWorkerEnv(process.env),
    });
    this.child = child;
    child.onData((data) => this.handlePtyData(data));
    child.onExit(({ exitCode, signal }) => {
      const code = signal ? 128 + signal : exitCode;
      log.info({ sessionId: this.sessionId, code }, "Terminal worker PTY exited");
      this.exit(code);
    });
    log.info(
      { sessionId: this.sessionId, pid: child.pid, shell, cwd: this.cwd },
      "Terminal worker PTY started",
    );
  }

  private handlePtyData(data: string): void {
    this.outputSeq += 1;
    this.terminal.write(data);
    const signal = extractOscSignals(data);
    if (signal?.title && this.socket?.writable) {
      this.socket.write(
        serializeIpc({ type: "pty_title_change", sessionId: this.sessionId, title: signal.title }),
      );
    }
    if (this.socket?.writable) {
      this.socket.write(
        encodeBinaryIpcFrame(this.sessionId, Buffer.from(data, "utf-8"), this.outputSeq),
      );
    }
  }

  private setupSocketHandlers(socket: Socket): void {
    createIpcReader(
      socket,
      (msg) => this.handleServeMessage(msg),
      undefined,
      (err, line) => {
        log.warn({ err: err.message, lineLen: line.length }, "Terminal worker IPC message dropped");
      },
    );
    socket.on("close", () => {
      if (this.exiting) return;
      log.info(
        { sessionId: this.sessionId },
        "Serve socket closed; terminal worker will reconnect",
      );
      void this.reconnectToServe();
    });
    socket.on("error", (err) => {
      log.warn({ sessionId: this.sessionId, err: err.message }, "Terminal worker socket error");
    });
  }

  private handleServeMessage(msg: IpcMessage): void {
    if ("sessionId" in msg && msg.sessionId !== this.sessionId) return;
    switch (msg.type) {
      case "pty_input":
        this.child?.write(msg.data);
        break;
      case "pty_subscribe":
        if (this.socket?.writable) {
          this.socket.write(
            serializeIpc({
              type: "pty_snapshot",
              sessionId: this.sessionId,
              cols: this.terminal.cols,
              rows: this.terminal.rows,
              data: this.serializeAddon.serialize(),
              outputSeq: this.outputSeq,
              requestId: msg.requestId,
            }),
          );
        }
        break;
      case "pty_resize_request":
        this.resize(msg.cols, msg.rows);
        break;
      case "pty_terminate":
        this.shutdown(0);
        break;
      case "pty_detach":
        this.socket?.end();
        break;
    }
  }

  private resize(cols: number, rows: number): void {
    this.child?.resize(cols, rows);
    this.terminal.resize(cols, rows);
    if (this.socket?.writable) {
      this.socket.write(
        serializeIpc({ type: "pty_resize", sessionId: this.sessionId, cols, rows }),
      );
    }
    log.info({ sessionId: this.sessionId, cols, rows }, "Terminal worker PTY resized");
  }

  private async reconnectToServe(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let i = 0; !this.exiting; i += 1) {
        await sleep(Math.min(RECONNECT_INITIAL_DELAY_MS * (i + 1), RECONNECT_MAX_DELAY_MS));
        const stopped = existsSync(STOPPED_PATH);
        const newSocket = stopped ? await tryConnect(SOCK_PATH) : await ensureService();
        if (!newSocket) continue;
        this.socket = this.socket ? swapServeSocket(this.socket, newSocket) : newSocket;
        this.setupSocketHandlers(this.socket);
        await this.registerWithServe();
        log.info({ sessionId: this.sessionId }, "Terminal worker reconnected to serve");
        this.reconnecting = false;
        return;
      }
    } catch (err) {
      log.warn(
        { sessionId: this.sessionId, err: err instanceof Error ? err.message : String(err) },
        "Terminal worker reconnect failed",
      );
      this.reconnecting = false;
      void this.reconnectToServe();
      return;
    }
    this.reconnecting = false;
  }

  private shutdown(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    try {
      this.child?.kill();
    } catch {
      // PTY may already have exited.
    }
    this.exit(code);
  }

  private exit(code: number): void {
    if (this.exiting && !this.child) return;
    this.exiting = true;
    this.child = null;
    this.terminal.dispose();
    if (this.socket?.writable) {
      const socket = this.socket;
      const timer = setTimeout(() => process.exit(code), 500);
      socket.end(serializeIpc({ type: "pty_deregister", sessionId: this.sessionId }), () => {
        clearTimeout(timer);
        process.exit(code);
      });
      return;
    }
    process.exit(code);
  }
}

const parsedArgs = parseTerminalWorkerCliArgs(process.argv.slice(2));
if (!parsedArgs) {
  console.error("Usage: terminal-worker [--profile <name>] <sessionId> <cwd> <name>");
  process.exit(1);
}

const { sessionId, cwd, name } = parsedArgs;
new ShellTerminalWorker(sessionId, cwd, name).run().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Terminal worker failed");
  process.exit(1);
});
