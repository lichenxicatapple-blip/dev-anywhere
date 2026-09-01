import { spawn, type ChildProcess } from "node:child_process";
import { LineBuffer } from "../ipc/line-buffer.js";
import { KIMI_PROVIDER, resolveKimiAcpMode, type KimiAcpMode } from "../providers/kimi.js";
import { PROXY_VERSION } from "../version.js";

export type KimiAcpPermissionBehavior = "allow_once" | "allow_always" | "deny" | "cancel";
export type KimiAcpJsonRpcId = string | number;

export interface KimiAcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
  [key: string]: unknown;
}

export interface KimiAcpPermissionRequest {
  requestId: KimiAcpJsonRpcId;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  rawToolCall: Record<string, unknown>;
  toolCall: Record<string, unknown>;
  options: KimiAcpPermissionOption[];
  rawParams: Record<string, unknown>;
}

export interface KimiAcpPermissionDecision {
  // Dynamic question/plan options can be selected exactly by id. When omitted, behavior is
  // mapped to the safest matching option advertised by this individual request.
  optionId?: string;
  behavior?: KimiAcpPermissionBehavior;
  cancelled?: boolean;
  message?: string;
}

export interface KimiAcpPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface KimiAcpSessionOptions {
  cwd?: string;
  workDir?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelAcknowledgeTimeoutMs?: number;
  onUpdate?: (params: Record<string, unknown>) => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onPermissionRequest?: (
    request: KimiAcpPermissionRequest,
  ) => Promise<KimiAcpPermissionDecision> | KimiAcpPermissionDecision;
  onPromptStart?: () => void;
  onPromptComplete?: (result: KimiAcpPromptResult) => void;
  onPromptError?: (error: Error) => void;
  onSessionId?: (sessionId: string) => void;
  onProtocolError?: (error: Error, line?: string) => void;
  onProcessError?: (error: Error) => void;
  onExit?: (code: number) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface ActivePrompt {
  cancelled: boolean;
  requestId?: KimiAcpJsonRpcId;
  cancelSettleTimer?: NodeJS.Timeout;
}

interface PendingPermission {
  request: KimiAcpPermissionRequest;
  responded: boolean;
}

const CLIENT_INFO = {
  name: "dev-anywhere",
  title: "Dev Anywhere",
  version: PROXY_VERSION,
};
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_ACKNOWLEDGE_TIMEOUT_MS = 2_000;
const STDERR_TAIL_LIMIT = 8_192;
const CANCELLED_RESPONSE_TOMBSTONE_LIMIT = 128;

const denyPermission = (): KimiAcpPermissionDecision => ({
  behavior: "deny",
  message: "Tool use denied by default policy. Remote approval is not configured.",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeApprovalInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const input = { ...value };
  if (Array.isArray(input.command)) {
    input.command = input.command.map((part) => String(part)).join(" ");
  }
  return input;
}

function parsePermissionOptions(value: unknown): KimiAcpPermissionOption[] {
  if (!Array.isArray(value)) return [];
  const options: KimiAcpPermissionOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.optionId !== "string") continue;
    options.push({
      ...candidate,
      optionId: candidate.optionId,
      name: typeof candidate.name === "string" ? candidate.name : candidate.optionId,
      kind: typeof candidate.kind === "string" ? candidate.kind : "",
    });
  }
  return options;
}

function normalizedOptionText(option: KimiAcpPermissionOption): string {
  return `${option.optionId} ${option.name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function isAllowOption(option: KimiAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  return option.kind.startsWith("allow") || /\b(allow|approve|accept)\b/.test(text);
}

function isAlwaysOption(option: KimiAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  return option.kind === "allow_always" || /\b(always|session|persist)\b/.test(text);
}

function isDenyOption(option: KimiAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  return option.kind.startsWith("reject") || /\b(reject|deny|decline|cancel|skip)\b/.test(text);
}

function optionMatchesBehavior(
  option: KimiAcpPermissionOption,
  behavior: Exclude<KimiAcpPermissionBehavior, "cancel">,
): boolean {
  if (behavior === "deny") return isDenyOption(option);
  if (behavior === "allow_always") {
    return isAllowOption(option) && isAlwaysOption(option);
  }
  return isAllowOption(option) && !isAlwaysOption(option);
}

function selectPermissionOption(
  options: KimiAcpPermissionOption[],
  behavior: Exclude<KimiAcpPermissionBehavior, "cancel">,
): KimiAcpPermissionOption | undefined {
  if (behavior === "deny") {
    return options.find((option) => option.kind.startsWith("reject")) ?? options.find(isDenyOption);
  }

  if (behavior === "allow_always") {
    return (
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => isAllowOption(option) && isAlwaysOption(option)) ??
      // Never upgrade a one-shot decision, but safely downgrade a persistent allow when the
      // provider only advertises allow-once.
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => isAllowOption(option) && !isAlwaysOption(option))
    );
  }

  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => isAllowOption(option) && !isAlwaysOption(option))
  );
}

function promptResult(value: unknown): KimiAcpPromptResult {
  return isRecord(value) ? value : {};
}

function responseErrorMessage(error: Record<string, unknown>): string {
  return typeof error.message === "string" ? error.message : "Kimi ACP request failed";
}

export class KimiAcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Kimi ACP ${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`);
    this.name = "KimiAcpRpcError";
  }
}

export class KimiAcpProtocolError extends Error {
  constructor(
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "KimiAcpProtocolError";
  }
}

export class KimiAcpSession {
  private child: ChildProcess | null = null;
  private stderrTail = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<KimiAcpJsonRpcId, PendingRequest>();
  private readonly pendingPermissions = new Map<KimiAcpJsonRpcId, PendingPermission>();
  private readonly cancelledResponseIds = new Set<KimiAcpJsonRpcId>();
  private readonly toolCalls = new Map<string, Record<string, unknown>>();
  private sessionReady: Promise<string>;
  private resolveSessionReady: (sessionId: string) => void = () => {};
  private rejectSessionReady: (error: Error) => void = () => {};
  private sessionReadySettled = false;
  private exitReported = false;
  private closed = false;
  private transportFailure: Error | null = null;
  private sessionId: string | null = null;
  private activePrompt: ActivePrompt | null = null;
  private promptQueue: Promise<void> = Promise.resolve();
  private readonly workDir: string;
  private readonly resumeSessionId?: string;
  private readonly acpMode: KimiAcpMode;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly cancelAcknowledgeTimeoutMs: number;
  private readonly onUpdate?: (params: Record<string, unknown>) => void;
  private readonly onNotification?: (method: string, params: Record<string, unknown>) => void;
  private readonly onPermissionRequest: (
    request: KimiAcpPermissionRequest,
  ) => Promise<KimiAcpPermissionDecision> | KimiAcpPermissionDecision;
  private readonly onPromptStart?: () => void;
  private readonly onPromptComplete?: (result: KimiAcpPromptResult) => void;
  private readonly onPromptError?: (error: Error) => void;
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly onProtocolError?: (error: Error, line?: string) => void;
  private readonly onProcessError?: (error: Error) => void;
  private readonly onExitCb?: (code: number) => void;

  constructor(options: KimiAcpSessionOptions = {}) {
    this.workDir = options.cwd ?? options.workDir ?? process.cwd();
    this.resumeSessionId = options.resumeSessionId;
    this.acpMode = resolveKimiAcpMode(options.permissionMode);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.cancelAcknowledgeTimeoutMs =
      options.cancelAcknowledgeTimeoutMs ?? DEFAULT_CANCEL_ACKNOWLEDGE_TIMEOUT_MS;
    this.onUpdate = options.onUpdate;
    this.onNotification = options.onNotification;
    this.onPermissionRequest = options.onPermissionRequest ?? denyPermission;
    this.onPromptStart = options.onPromptStart;
    this.onPromptComplete = options.onPromptComplete;
    this.onPromptError = options.onPromptError;
    this.onSessionId = options.onSessionId;
    this.onProtocolError = options.onProtocolError;
    this.onProcessError = options.onProcessError;
    this.onExitCb = options.onExit;
    this.sessionReady = new Promise((resolve, reject) => {
      this.resolveSessionReady = resolve;
      this.rejectSessionReady = reject;
    });
  }

  getKimiSessionId(): string | null {
    return this.sessionId;
  }

  getPendingPermission(requestId: KimiAcpJsonRpcId): KimiAcpPermissionRequest | undefined {
    return this.pendingPermissions.get(requestId)?.request;
  }

  start(): number {
    if (this.child) throw new Error("Kimi ACP session has already been started");
    const command = KIMI_PROVIDER.buildJsonCommand({}, process.env);
    this.child = spawn(command.command, command.args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env,
    });

    this.setupStdoutParsing();
    this.setupStderrCollection();
    this.setupExitHandler();
    void this.initializeSession().catch((error) => this.rejectSessionReadyOnce(toError(error)));

    if (!this.child.pid) throw new Error("Kimi ACP failed to start: missing child pid");
    return this.child.pid;
  }

  waitUntilReady(): Promise<string> {
    return this.sessionReady;
  }

  sendMessage(content: string): void {
    this.promptQueue = this.promptQueue.then(() => this.runPrompt(content));
  }

  async interruptCurrentTurn(): Promise<boolean> {
    const activePrompt = this.activePrompt;
    if (!activePrompt || activePrompt.cancelled || !this.sessionId) return false;
    activePrompt.cancelled = true;
    if (
      !this.writeLine({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      })
    ) {
      activePrompt.cancelled = false;
      return false;
    }
    this.cancelPendingPermissions();
    if (this.cancelAcknowledgeTimeoutMs <= 0) {
      this.abortUnacknowledgedCancellation(activePrompt);
    } else {
      activePrompt.cancelSettleTimer = setTimeout(
        () => this.abortUnacknowledgedCancellation(activePrompt),
        this.cancelAcknowledgeTimeoutMs,
      );
      activePrompt.cancelSettleTimer.unref?.();
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.child) throw new Error("Kimi ACP session has not been started");
    const sessionId = this.sessionId ?? (await this.sessionReady);
    await this.request("session/close", { sessionId });
    this.closed = true;
  }

  async stop(gracePeriodMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child || !this.isAlive()) return;

    if (this.activePrompt) await this.interruptCurrentTurn();
    if (this.sessionId && !this.closed) {
      try {
        await this.close();
      } catch (error) {
        this.appendStderr(`Kimi ACP close failed: ${toError(error).message}\n`);
      }
    }

    child.kill("SIGTERM");
    const startedAt = Date.now();
    while (Date.now() - startedAt < gracePeriodMs) {
      if (!this.isChildAlive(child)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.isChildAlive(child)) child.kill("SIGKILL");
  }

  isAlive(): boolean {
    return this.child ? this.isChildAlive(this.child) : false;
  }

  getStderr(): string {
    return this.stderrTail;
  }

  private isChildAlive(child: ChildProcess): boolean {
    if (!child.pid) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async initializeSession(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: CLIENT_INFO,
    });

    const result = this.resumeSessionId
      ? await this.request("session/resume", {
          sessionId: this.resumeSessionId,
          cwd: this.workDir,
          mcpServers: [],
        })
      : await this.request("session/new", {
          cwd: this.workDir,
          mcpServers: [],
        });
    const sessionId = this.resumeSessionId ?? this.sessionIdFromResult(result);
    if (!sessionId) throw new Error("Kimi ACP session/new did not return a session id");

    await this.request("session/set_mode", { sessionId, modeId: this.acpMode });
    this.sessionId = sessionId;
    this.onSessionId?.(sessionId);
    this.resolveSessionReadyOnce(sessionId);
  }

  private sessionIdFromResult(result: unknown): string | null {
    if (!isRecord(result)) return null;
    return typeof result.sessionId === "string" ? result.sessionId : null;
  }

  private async runPrompt(content: string): Promise<void> {
    let prompt: ActivePrompt | null = null;
    try {
      const sessionId = await this.sessionReady;
      if (this.transportFailure) throw this.transportFailure;
      const currentPrompt: ActivePrompt = { cancelled: false };
      prompt = currentPrompt;
      this.activePrompt = currentPrompt;
      this.invokeCallback(() => this.onPromptStart?.(), "session/prompt start callback failed");
      const result = await this.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: content }],
        },
        this.promptTimeoutMs,
        (requestId) => {
          if (this.activePrompt === currentPrompt) currentPrompt.requestId = requestId;
        },
      );
      if (!prompt.cancelled) {
        this.invokeCallback(
          () => this.onPromptComplete?.(promptResult(result)),
          "session/prompt completion callback failed",
        );
      }
    } catch (error) {
      if (!prompt?.cancelled) {
        this.invokeCallback(
          () => this.onPromptError?.(toError(error)),
          "session/prompt error callback failed",
        );
      }
    } finally {
      if (prompt?.cancelSettleTimer) clearTimeout(prompt.cancelSettleTimer);
      if (this.activePrompt === prompt) this.activePrompt = null;
      this.toolCalls.clear();
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    onRequestId?: (requestId: KimiAcpJsonRpcId) => void,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    onRequestId?.(id);
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`Kimi ACP request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      timeout?.unref?.();
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      if (!this.writeLine(payload)) {
        if (timeout) clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Kimi ACP stdin is not writable for ${method}`));
      }
    });
  }

  private writeLine(payload: Record<string, unknown>): boolean {
    if (this.transportFailure || !this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (error) {
      this.reportProtocolError(new KimiAcpProtocolError("Failed to write Kimi ACP message", error));
      return false;
    }
  }

  private setupStdoutParsing(): void {
    const child = this.child;
    if (!child?.stdout) return;
    const lineBuffer = new LineBuffer();
    child.stdout.pipe(lineBuffer);
    lineBuffer.on("data", (line: Buffer | string) => {
      const text = typeof line === "string" ? line : line.toString();
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch (error) {
        this.reportProtocolError(
          new KimiAcpProtocolError(`Invalid Kimi ACP JSON: ${toError(error).message}`, text),
          text,
        );
        return;
      }
      this.handleAcpMessage(message);
    });
  }

  private handleAcpMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.reportProtocolError(
        new KimiAcpProtocolError("Kimi ACP message must be an object", message),
      );
      return;
    }

    const id = message.id;
    const method = message.method;
    if (typeof method === "string" && (typeof id === "string" || typeof id === "number")) {
      this.handleServerRequest({ id, method, params: message.params });
      return;
    }
    if (typeof method === "string") {
      this.handleNotification(method, message.params);
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      this.handleResponse(id, message);
      return;
    }
    this.reportProtocolError(new KimiAcpProtocolError("Unrecognized Kimi ACP message", message));
  }

  private handleResponse(id: KimiAcpJsonRpcId, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      if (this.cancelledResponseIds.delete(id)) return;
      this.reportProtocolError(
        new KimiAcpProtocolError(`Unexpected Kimi ACP response id: ${String(id)}`, message),
      );
      return;
    }
    this.pendingRequests.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(
        new KimiAcpRpcError(
          pending.method,
          typeof message.error.code === "number" ? message.error.code : undefined,
          responseErrorMessage(message.error),
          message.error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private abortUnacknowledgedCancellation(prompt: ActivePrompt): void {
    const requestId = prompt.requestId;
    if (requestId === undefined) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.method !== "session/prompt") return;
    const error = new Error(
      `Kimi ACP did not acknowledge session/cancel within ${this.cancelAcknowledgeTimeoutMs}ms; terminating the unsafe transport`,
    );
    this.transportFailure = error;
    this.pendingRequests.delete(requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    this.cancelledResponseIds.add(requestId);
    if (this.cancelledResponseIds.size > CANCELLED_RESPONSE_TOMBSTONE_LIMIT) {
      const oldest = this.cancelledResponseIds.values().next().value;
      if (oldest !== undefined) this.cancelledResponseIds.delete(oldest);
    }
    this.appendStderr(`${error.message}\n`);
    this.cancelPendingPermissions();
    pending.reject(error);
    // The old ACP process may still believe the cancelled prompt is live. Never let a queued
    // prompt or late permission request share that transport; a fresh session can safely resume
    // from Kimi's durable native history after the worker exits.
    this.child?.kill("SIGKILL");
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = isRecord(rawParams) ? rawParams : {};
    if (method === "session/update") {
      this.trackToolCall(params);
      this.invokeCallback(() => this.onUpdate?.(params), "session/update callback failed");
    }
    this.invokeCallback(
      () => this.onNotification?.(method, params),
      `${method} notification callback failed`,
    );
  }

  private trackToolCall(params: Record<string, unknown>): void {
    if (!isRecord(params.update) || typeof params.update.toolCallId !== "string") return;
    const previous = this.toolCalls.get(params.update.toolCallId) ?? {};
    const next = { ...previous, ...params.update };
    if (next.status === "completed" || next.status === "failed") {
      this.toolCalls.delete(params.update.toolCallId);
      return;
    }
    this.toolCalls.set(params.update.toolCallId, next);
  }

  private handleServerRequest(request: {
    id: KimiAcpJsonRpcId;
    method: string;
    params?: unknown;
  }): void {
    if (request.method === "session/request_permission") {
      void this.handlePermissionRequest(request.id, request.params);
      return;
    }
    this.writeLine({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unsupported Kimi ACP client request: ${request.method}` },
    });
  }

  private async handlePermissionRequest(id: KimiAcpJsonRpcId, rawParams: unknown): Promise<void> {
    const params = isRecord(rawParams) ? rawParams : {};
    const incomingToolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId =
      typeof incomingToolCall.toolCallId === "string" ? incomingToolCall.toolCallId : undefined;
    const trackedToolCall = toolCallId ? (this.toolCalls.get(toolCallId) ?? {}) : {};
    const toolCall = { ...trackedToolCall, ...incomingToolCall };
    const rawInput = isRecord(incomingToolCall.rawInput)
      ? incomingToolCall.rawInput
      : trackedToolCall.rawInput;
    const request: KimiAcpPermissionRequest = {
      requestId: id,
      sessionId: typeof params.sessionId === "string" ? params.sessionId : (this.sessionId ?? ""),
      toolName:
        typeof incomingToolCall.title === "string"
          ? incomingToolCall.title
          : typeof trackedToolCall.title === "string"
            ? trackedToolCall.title
            : "Tool",
      input: normalizeApprovalInput(rawInput),
      rawToolCall: incomingToolCall,
      toolCall,
      options: parsePermissionOptions(params.options),
      rawParams: params,
    };

    // A permission request can race with session/cancel on separate protocol directions.
    // Once the active prompt is cancelled, never reopen approval for that turn.
    if (this.transportFailure || this.activePrompt?.cancelled) {
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    const pending: PendingPermission = { request, responded: false };
    this.pendingPermissions.set(id, pending);

    let decision: KimiAcpPermissionDecision;
    try {
      decision = await this.onPermissionRequest(request);
    } catch (error) {
      decision = { behavior: "deny", message: toError(error).message };
    }

    if (pending.responded) return;
    pending.responded = true;
    this.pendingPermissions.delete(id);

    const requestedOptionId =
      typeof decision.optionId === "string" && decision.optionId.trim().length > 0
        ? decision.optionId
        : undefined;
    const explicitOption = requestedOptionId
      ? request.options.find((candidate) => candidate.optionId === requestedOptionId)
      : undefined;
    const cancelled = decision.cancelled === true || decision.behavior === "cancel";
    const behavior: Exclude<KimiAcpPermissionBehavior, "cancel"> | undefined =
      decision.behavior === "allow_once" ||
      decision.behavior === "allow_always" ||
      decision.behavior === "deny"
        ? decision.behavior
        : undefined;
    const validExplicitOption =
      explicitOption && (!behavior || optionMatchesBehavior(explicitOption, behavior))
        ? explicitOption
        : undefined;
    const option =
      cancelled || requestedOptionId || !behavior
        ? undefined
        : selectPermissionOption(request.options, behavior);
    const selectedOptionId = cancelled
      ? undefined
      : validExplicitOption?.optionId || option?.optionId;
    const outcome = selectedOptionId
      ? { outcome: "selected", optionId: selectedOptionId }
      : { outcome: "cancelled" };
    if (!this.writeLine({ jsonrpc: "2.0", id, result: { outcome } })) {
      this.reportProtocolError(
        new KimiAcpProtocolError(`Failed to respond to permission request ${String(id)}`),
      );
    }
  }

  private cancelPendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.responded) continue;
      pending.responded = true;
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    this.pendingPermissions.clear();
  }

  private setupStderrCollection(): void {
    const child = this.child;
    if (!child?.stderr) return;
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.appendStderr(typeof chunk === "string" ? chunk : chunk.toString());
    });
  }

  private setupExitHandler(): void {
    const child = this.child;
    if (!child) return;
    child.on("error", (error: Error) => {
      const wrapped = new Error(`Kimi ACP failed to start: ${error.message}`);
      this.appendStderr(`${wrapped.message}\n`);
      this.rejectAllPendingRequests(wrapped);
      this.rejectSessionReadyOnce(wrapped);
      this.onProcessError?.(wrapped);
      this.reportExit(1);
    });
    child.on("exit", (code: number | null) => {
      const exitCode = code ?? 1;
      const error = new Error(
        this.sessionReadySettled
          ? `Kimi ACP exited (code ${exitCode})`
          : `Kimi ACP exited before ready (code ${exitCode})`,
      );
      this.rejectAllPendingRequests(error);
      this.pendingPermissions.clear();
      this.rejectSessionReadyOnce(error);
      if (exitCode !== 0) this.onProcessError?.(error);
      this.reportExit(exitCode);
    });
  }

  private invokeCallback(callback: () => void, message: string): void {
    try {
      callback();
    } catch (error) {
      this.reportProtocolError(new KimiAcpProtocolError(`${message}: ${toError(error).message}`));
    }
  }

  private reportProtocolError(error: Error, line?: string): void {
    this.appendStderr(`${error.message}\n`);
    try {
      this.onProtocolError?.(error, line);
    } catch {
      // A diagnostic callback must never break the ACP transport loop.
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
  }

  private resolveSessionReadyOnce(sessionId: string): void {
    if (this.sessionReadySettled) return;
    this.sessionReadySettled = true;
    this.resolveSessionReady(sessionId);
  }

  private rejectSessionReadyOnce(error: Error): void {
    if (this.sessionReadySettled) return;
    this.sessionReadySettled = true;
    this.rejectSessionReady(error);
  }

  private rejectAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.cancelledResponseIds.clear();
  }

  private reportExit(code: number): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.onExitCb?.(code);
  }
}
