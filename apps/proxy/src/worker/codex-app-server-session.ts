import { spawn, type ChildProcess } from "node:child_process";
import { LineBuffer } from "../ipc/line-buffer.js";
import { CODEX_PROVIDER } from "../providers/index.js";
import type { ApprovalStrategy, StreamJsonEvent } from "./json-session.js";

type JsonRpcId = string | number;
type CodexApprovalStyle = "item" | "legacy";

interface CodexAppServerSessionOptions {
  cwd?: string;
  workDir?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  requestTimeoutMs?: number;
  approvalStrategy?: ApprovalStrategy;
  onEvent?: (event: StreamJsonEvent) => void;
  onThreadId?: (threadId: string) => void;
  onExit?: (code: number) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const CLIENT_INFO = {
  name: "dev-anywhere",
  title: "Dev Anywhere",
  version: "0.0.0",
};
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function approvalPolicy(permissionMode?: string): "untrusted" | "on-request" | "never" {
  switch (permissionMode) {
    case "auto":
      return "on-request";
    case "bypassPermissions":
    case "dontAsk":
      return "never";
    default:
      return "untrusted";
  }
}

function sandboxMode(permissionMode?: string): "danger-full-access" | null {
  return permissionMode === "bypassPermissions" || permissionMode === "dontAsk"
    ? "danger-full-access"
    : null;
}

function getThreadId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const thread = (result as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") return null;
  const id = (thread as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeApprovalInput(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  const input = { ...params };
  if (Array.isArray(input.command)) {
    input.command = input.command.map((part) => String(part)).join(" ");
  }
  return input;
}

const denyAllStrategy: ApprovalStrategy = async () => ({
  behavior: "deny",
  message: "Tool use denied by default policy. Remote approval not yet configured.",
});

export class CodexAppServerSession {
  private child: ChildProcess | null = null;
  private stderrChunks: string[] = [];
  private nextRequestId = 1;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private threadReady: Promise<string>;
  private resolveThreadReady: (threadId: string) => void = () => {};
  private rejectThreadReady: (err: Error) => void = () => {};
  private threadReadySettled = false;
  private exitReported = false;
  private codexThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly workDir: string;
  private readonly resumeSessionId?: string;
  private readonly permissionMode?: string;
  private readonly requestTimeoutMs: number;
  private readonly approvalStrategy: ApprovalStrategy;
  private readonly onEvent?: (event: StreamJsonEvent) => void;
  private readonly onThreadId?: (threadId: string) => void;
  private readonly onExitCb?: (code: number) => void;

  constructor(options: CodexAppServerSessionOptions = {}) {
    this.workDir = options.cwd ?? options.workDir ?? process.cwd();
    this.resumeSessionId = options.resumeSessionId;
    this.permissionMode = options.permissionMode;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.approvalStrategy = options.approvalStrategy ?? denyAllStrategy;
    this.onEvent = options.onEvent;
    this.onThreadId = options.onThreadId;
    this.onExitCb = options.onExit;
    this.threadReady = new Promise((resolve, reject) => {
      this.resolveThreadReady = resolve;
      this.rejectThreadReady = reject;
    });
  }

  getCodexThreadId(): string | null {
    return this.codexThreadId;
  }

  start(): number {
    const command = CODEX_PROVIDER.buildJsonCommand({}, process.env);
    this.child = spawn(command.command, command.args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env,
    });

    this.setupStdoutParsing();
    this.setupStderrCollection();
    this.setupExitHandler();
    void this.initializeThread().catch((err) => this.rejectThreadReadyOnce(toError(err)));

    return this.child.pid!;
  }

  waitUntilReady(): Promise<string> {
    return this.threadReady;
  }

  sendMessage(content: string): void {
    void this.threadReady
      .then((threadId) =>
        this.request("turn/start", {
          threadId,
          input: [{ type: "text", text: content, text_elements: [] }],
          approvalPolicy: approvalPolicy(this.permissionMode),
        }).then((result) => {
          if (isRecord(result) && isRecord(result.turn) && typeof result.turn.id === "string") {
            this.activeTurnId = result.turn.id;
          }
        }),
      )
      .catch(() => {
        // Startup failure is surfaced through waitUntilReady / worker_ready; queued user input is dropped.
      });
  }

  async stop(gracePeriodMs = 5000): Promise<void> {
    if (!this.child || !this.isAlive()) return;
    this.child.kill("SIGTERM");
    const start = Date.now();
    while (Date.now() - start < gracePeriodMs) {
      if (!this.isAlive()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.isAlive()) this.child.kill("SIGKILL");
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.codexThreadId || !this.activeTurnId) return false;
    await this.request("turn/interrupt", {
      threadId: this.codexThreadId,
      turnId: this.activeTurnId,
    });
    return true;
  }

  isAlive(): boolean {
    if (!this.child?.pid) return false;
    try {
      process.kill(this.child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getStderr(): string {
    return this.stderrChunks.join("");
  }

  private async initializeThread(): Promise<void> {
    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    const result = this.resumeSessionId
      ? await this.request("thread/resume", this.threadParams({ threadId: this.resumeSessionId }))
      : await this.request("thread/start", this.threadParams());
    const threadId = getThreadId(result);
    if (!threadId) {
      throw new Error("Codex app-server thread start did not return a thread id");
    }
    this.codexThreadId = threadId;
    this.onThreadId?.(threadId);
    this.resolveThreadReadyOnce(threadId);
  }

  private threadParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const sandbox = sandboxMode(this.permissionMode);
    return {
      ...extra,
      cwd: this.workDir,
      approvalPolicy: approvalPolicy(this.permissionMode),
      ...(sandbox ? { sandbox } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Codex app-server request ${method} timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      if (!this.writeLine(payload)) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server stdin is not writable for ${method}`));
      }
    });
  }

  private writeLine(payload: Record<string, unknown>): boolean {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  private setupStdoutParsing(): void {
    const child = this.child;
    if (!child?.stdout) return;

    const lineBuffer = new LineBuffer();
    child.stdout.pipe(lineBuffer);
    lineBuffer.on("data", (line: Buffer | string) => {
      const str = typeof line === "string" ? line : line.toString();
      let message: unknown;
      try {
        message = JSON.parse(str);
      } catch {
        return;
      }
      this.handleAppServerMessage(message);
    });
  }

  private handleAppServerMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if ("id" in message && !("method" in message)) {
      this.handleResponse(message);
      return;
    }
    if ("id" in message && typeof message.method === "string") {
      this.handleServerRequest(message as { id: JsonRpcId; method: string; params?: unknown });
      return;
    }
    if (typeof message.method === "string") {
      this.onEvent?.({
        type: "codex_app_server",
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
      } as StreamJsonEvent);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id as JsonRpcId;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(new Error(String(message.error.message ?? "Codex app-server request failed")));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(request: { id: JsonRpcId; method: string; params?: unknown }): void {
    if (request.method === "item/commandExecution/requestApproval") {
      void this.handleApprovalRequest(request.id, "Bash", request.params, "item");
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      void this.handleApprovalRequest(request.id, "Patch", request.params, "item");
      return;
    }
    if (request.method === "execCommandApproval") {
      void this.handleApprovalRequest(request.id, "Bash", request.params, "legacy");
      return;
    }
    if (request.method === "applyPatchApproval") {
      void this.handleApprovalRequest(request.id, "Patch", request.params, "legacy");
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      void this.handlePermissionsApprovalRequest(request.id, request.params);
      return;
    }
    this.writeLine({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unsupported Codex server request: ${request.method}` },
    });
  }

  private async handleApprovalRequest(
    id: JsonRpcId,
    toolName: string,
    params: unknown,
    style: CodexApprovalStyle,
  ): Promise<void> {
    const input = normalizeApprovalInput(params);
    let decision: Awaited<ReturnType<ApprovalStrategy>>;
    try {
      decision = await this.approvalStrategy(toolName, input);
    } catch (err) {
      decision = { behavior: "deny", message: err instanceof Error ? err.message : String(err) };
    }
    const allowed = decision.behavior === "allow";
    this.writeLine({
      jsonrpc: "2.0",
      id,
      result: {
        decision: allowed
          ? style === "legacy"
            ? "approved"
            : "accept"
          : style === "legacy"
            ? "denied"
            : "decline",
      },
    });
  }

  private async handlePermissionsApprovalRequest(id: JsonRpcId, params: unknown): Promise<void> {
    const input = normalizeApprovalInput(params);
    let decision: Awaited<ReturnType<ApprovalStrategy>>;
    try {
      decision = await this.approvalStrategy("Permissions", input);
    } catch (err) {
      decision = { behavior: "deny", message: err instanceof Error ? err.message : String(err) };
    }

    const requestedPermissions = isRecord(input.permissions) ? input.permissions : {};
    const allowed = decision.behavior === "allow";
    this.writeLine({
      jsonrpc: "2.0",
      id,
      result: {
        permissions: allowed ? requestedPermissions : {},
        scope: "turn",
        ...(allowed ? {} : { strictAutoReview: true }),
      },
    });
  }

  private setupStderrCollection(): void {
    const child = this.child;
    if (!child?.stderr) return;
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    });
  }

  private setupExitHandler(): void {
    const child = this.child;
    if (!child) return;
    child.on("error", (err: Error) => {
      const error = new Error(`Codex app-server failed to start: ${err.message}`);
      this.stderrChunks.push(`${error.message}\n`);
      this.rejectAllPendingRequests(error);
      this.rejectThreadReadyOnce(error);
      this.reportExit(1);
    });
    child.on("exit", (code: number | null) => {
      const exitCode = code ?? 1;
      const err = new Error(`Codex app-server exited before ready (code ${exitCode})`);
      this.rejectAllPendingRequests(err);
      this.rejectThreadReadyOnce(err);
      this.reportExit(exitCode);
    });
  }

  private reportExit(code: number): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.onExitCb?.(code);
  }

  private resolveThreadReadyOnce(threadId: string): void {
    if (this.threadReadySettled) return;
    this.threadReadySettled = true;
    this.resolveThreadReady(threadId);
  }

  private rejectThreadReadyOnce(err: Error): void {
    if (this.threadReadySettled) return;
    this.threadReadySettled = true;
    this.rejectThreadReady(err);
  }

  private rejectAllPendingRequests(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
