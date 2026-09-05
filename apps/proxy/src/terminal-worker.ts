import type { Socket } from "node:net";
import { existsSync } from "node:fs";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { terminalLogger as log } from "./common/logger.js";
import { SOCK_PATH, STOPPED_PATH } from "./common/paths.js";
import { PtyRuntime, type PtyRuntimeExit } from "./common/pty-runtime.js";
import { sanitizeProviderErrorTail } from "./common/codex-session-conflict.js";
import {
  createIpcReader,
  encodeBinaryIpcFrame,
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
  type IpcMessage,
} from "./ipc/ipc-protocol.js";
import {
  parseTerminalWorkerBootstrap,
  parseTerminalWorkerCliArgs,
  type TerminalWorkerBootstrap,
  type TerminalWorkerCliArgs,
} from "./terminal-worker-args.js";
import {
  ensureService,
  IpcProtocolError,
  tryConnect,
  waitForMessage,
} from "./terminal/serve-bootstrap.js";
import { swapServeSocket } from "./terminal/serve-socket-swap.js";
import { ReconnectSupervisor } from "./terminal/reconnect-supervisor.js";
import {
  requestTerminalAdmission,
  TerminalAdmissionRetiredError,
} from "./terminal/admission-client.js";

class TerminalRegistrationRejectedError extends Error {}

class TerminalWorker {
  private socket: Socket | null = null;
  private runtime: PtyRuntime | null = null;
  private exiting = false;
  private approvalWaiting = false;
  private currentCwd: string;
  private readonly reconnectSupervisor = new ReconnectSupervisor({
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
  });

  constructor(
    private readonly identity: TerminalWorkerCliArgs,
    private readonly bootstrap: TerminalWorkerBootstrap,
  ) {
    this.currentCwd = bootstrap.cwd;
  }

  async run(): Promise<void> {
    process.on("SIGTERM", () => this.shutdown(143));
    process.on("SIGINT", () => this.shutdown(130));
    // This worker belongs to an existing daemon; bootstrap must not revive a stopped service.
    this.socket = await ensureService("connect-only");
    await this.admit(this.socket);
    this.setupSocketHandlers(this.socket);
    await this.registerWithServe();
    try {
      this.startPty();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        { sessionId: this.identity.sessionId, error: message },
        "Terminal worker PTY failed to start",
      );
      this.exit({
        exitCode: 1,
        errorTail: sanitizeProviderErrorTail(message),
        runtimeError: { errorCode: ControlErrorCode.PROCESS_START_FAILED, error: message },
      });
    }
  }

  private async admit(socket: Socket): Promise<void> {
    await requestTerminalAdmission(socket, {
      clientKind: "terminal-worker",
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      sessionId: this.identity.sessionId,
    });
  }

  private async registerWithServe(): Promise<void> {
    if (!this.socket?.writable) throw new Error("Serve socket is not writable");
    const responsePromise = waitForMessage(this.socket, "session_create_response");
    const registration = {
      type: "session_create_request" as const,
      protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      mode: "pty" as const,
      cwd: this.currentCwd,
      pid: process.pid,
      sessionId: this.identity.sessionId,
      name: this.bootstrap.name,
    };
    this.socket.write(
      serializeIpc(
        this.identity.kind === "terminal"
          ? { ...registration, kind: "terminal", provider: "claude" }
          : { ...registration, kind: "agent", provider: this.identity.provider },
      ),
    );
    let response: Awaited<typeof responsePromise>;
    try {
      response = await responsePromise;
    } catch (error) {
      if (error instanceof IpcProtocolError)
        throw new TerminalRegistrationRejectedError(error.message);
      throw error;
    }
    if (!response.success)
      throw new TerminalRegistrationRejectedError(
        `Failed to register terminal worker: ${response.error}`,
      );
    this.socket.write(
      serializeIpc({ type: "pty_register", sessionId: this.identity.sessionId, pid: process.pid }),
    );
    this.runtime?.replaySemanticState();
    log.info({ sessionId: this.identity.sessionId }, "Terminal worker registered with serve");
  }

  private startPty(): void {
    if (this.runtime) return;
    const { sessionId } = this.identity;
    const bootstrap = this.bootstrap;
    const base = {
      sessionId,
      cwd: bootstrap.cwd,
      cols: bootstrap.cols,
      rows: bootstrap.rows,
      env: process.env,
    };
    this.runtime = new PtyRuntime(
      bootstrap.kind === "terminal"
        ? { ...base, kind: "terminal", shell: bootstrap.shell }
        : {
            ...base,
            kind: "agent",
            provider: bootstrap.provider,
            args: bootstrap.args,
            permissionMode: bootstrap.permissionMode,
            nativeSessionId: bootstrap.nativeSessionId,
            hook: bootstrap.hook,
          },
      {
        output: (data, outputSeq) => {
          if (this.socket?.writable)
            this.socket.write(
              encodeBinaryIpcFrame(sessionId, Buffer.from(data, "utf8"), outputSeq),
            );
        },
        resize: (cols, rows, outputSeq) =>
          this.send({ type: "pty_resize", sessionId, cols, rows, outputSeq }),
        title: (title) => this.send({ type: "pty_title_change", sessionId, title }),
        cwd: (cwd) => {
          if (cwd === this.currentCwd) return;
          this.currentCwd = cwd;
          this.send({ type: "pty_cwd_change", sessionId, cwd });
        },
        semantic: (state, seq, meta) =>
          this.send({ type: "pty_semantic_event", sessionId, state, seq, ...meta }),
        exit: (event) => this.exit(event),
      },
    );
    this.runtime.setApprovalWaiting(this.approvalWaiting);
    this.runtime.start();
  }

  private send(message: IpcMessage): void {
    if (this.socket?.writable) this.socket.write(serializeIpc(message));
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
      if (this.exiting || this.socket !== socket) return;
      log.info(
        { sessionId: this.identity.sessionId },
        "Serve socket closed; terminal worker will reconnect",
      );
      this.reconnectToServe();
    });
    socket.on("error", (err) =>
      log.warn(
        { sessionId: this.identity.sessionId, err: err.message },
        "Terminal worker socket error",
      ),
    );
  }

  private handleServeMessage(msg: IpcMessage): void {
    if ("sessionId" in msg && msg.sessionId !== this.identity.sessionId) return;
    switch (msg.type) {
      case "pty_input":
        this.runtime?.write(msg.data);
        log.debug(
          { sessionId: this.identity.sessionId, traceId: msg.traceId, bytes: msg.data.length },
          "Raw PTY input written to worker PTY",
        );
        break;
      case "pty_subscribe": {
        const responseSocket = this.socket;
        if (!responseSocket?.writable) break;
        this.runtime?.snapshot((snapshot) => {
          if (this.socket !== responseSocket || !responseSocket.writable) return;
          responseSocket.write(
            serializeIpc({
              type: "pty_snapshot",
              sessionId: this.identity.sessionId,
              ...snapshot,
              requestId: msg.requestId,
            }),
          );
        });
        break;
      }
      case "pty_resize_request":
        this.runtime?.resize(msg.cols, msg.rows);
        break;
      case "pty_approval_context":
        this.approvalWaiting = msg.waiting;
        this.runtime?.setApprovalWaiting(msg.waiting);
        break;
      case "bridge_status":
        if (msg.connected) this.runtime?.replaySemanticState();
        break;
      case "pty_terminate":
        this.shutdown(0);
        break;
      case "pty_detach":
        this.socket?.end();
        break;
    }
  }

  private reconnectToServe(): void {
    let consecutiveSpawnFailures = 0;
    const run = this.reconnectSupervisor.request({
      shouldStop: () => this.exiting,
      attempt: async (attempt) => {
        const passive = existsSync(STOPPED_PATH) || consecutiveSpawnFailures >= 3;
        let candidate: Socket | null = null;
        try {
          candidate = passive ? await tryConnect(SOCK_PATH) : await ensureService("reconnect");
          if (!candidate) return "retry";
          await this.admit(candidate);
          consecutiveSpawnFailures = 0;
          this.socket = this.socket ? swapServeSocket(this.socket, candidate) : candidate;
          this.setupSocketHandlers(this.socket);
          await this.registerWithServe();
          log.info(
            { sessionId: this.identity.sessionId, attempt },
            "Terminal worker reconnected to serve",
          );
          return "connected";
        } catch (err) {
          candidate?.destroy();
          if (this.socket === candidate) this.socket = null;
          log.warn(
            {
              sessionId: this.identity.sessionId,
              attempt,
              err: err instanceof Error ? err.message : String(err),
            },
            "Terminal worker reconnect failed",
          );
          if (
            err instanceof TerminalRegistrationRejectedError ||
            err instanceof TerminalAdmissionRetiredError
          ) {
            this.shutdown(1);
            return "stop";
          }
          if (!passive && ++consecutiveSpawnFailures === 3) {
            log.warn(
              { sessionId: this.identity.sessionId, failures: consecutiveSpawnFailures },
              "Terminal worker daemon auto-start disabled after repeated failures",
            );
          }
          return "retry";
        }
      },
    });
    if (run.started)
      void run.completion.catch((err: unknown) => {
        log.error(
          {
            sessionId: this.identity.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Terminal worker reconnect loop failed",
        );
        this.shutdown(1);
      });
  }

  private shutdown(exitCode: number): void {
    if (this.exiting) return;
    this.runtime?.terminate();
    this.exit({ exitCode });
  }

  private exit(event: PtyRuntimeExit): void {
    if (this.exiting) return;
    this.exiting = true;
    this.runtime?.terminate();
    this.runtime = null;
    log.info({ sessionId: this.identity.sessionId, ...event }, "Terminal worker PTY exited");
    if (this.socket?.writable) {
      const timer = setTimeout(() => process.exit(event.exitCode), 500);
      this.socket.end(
        serializeIpc({ type: "pty_deregister", sessionId: this.identity.sessionId, ...event }),
        () => {
          clearTimeout(timer);
          process.exit(event.exitCode);
        },
      );
    } else process.exit(event.exitCode);
  }
}

function readBootstrap(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const timer = setTimeout(() => reject(new Error("Terminal worker bootstrap timed out")), 5_000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 65_536) {
        clearTimeout(timer);
        reject(new Error("Terminal worker bootstrap exceeds size limit"));
        process.stdin.destroy();
      }
    });
    process.stdin.once("end", () => {
      clearTimeout(timer);
      resolve(raw);
    });
    process.stdin.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  const identity = parseTerminalWorkerCliArgs(process.argv.slice(2));
  if (!identity)
    throw new Error(
      "Usage: terminal-worker --profile <name> --session <id> --kind <agent|terminal> --provider <provider>",
    );
  const bootstrap = parseTerminalWorkerBootstrap(await readBootstrap(), identity);
  await new TerminalWorker(identity, bootstrap).run();
}

void main().catch(async (err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Terminal worker failed");
  await flushLogger(log);
  process.exit(1);
});
