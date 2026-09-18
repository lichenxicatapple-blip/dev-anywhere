import type { ChildProcess } from "node:child_process";
import type { CursorAnswer, CursorPrompt } from "@dev-anywhere/shared";
import { spawnCommand } from "../common/command-launch.js";
import { terminateOwnedProcessTree } from "../common/process-termination.js";
import { LineBuffer } from "../ipc/line-buffer.js";
import {
  CURSOR_PROVIDER,
  cursorAcpAutoApprovesPermissions,
  resolveCursorAcpMode,
  type CursorAcpMode,
} from "../providers/cursor.js";
import { PROXY_VERSION } from "../version.js";

export type CursorAcpPermissionBehavior = "allow_once" | "allow_always" | "deny" | "cancel";
export type CursorAcpJsonRpcId = string | number;

export interface CursorAcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
  [key: string]: unknown;
}

export interface CursorAcpPermissionRequest {
  requestId: CursorAcpJsonRpcId;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  rawToolCall: Record<string, unknown>;
  toolCall: Record<string, unknown>;
  options: CursorAcpPermissionOption[];
  rawParams: Record<string, unknown>;
}

export interface CursorAcpPermissionDecision {
  optionId?: string;
  behavior?: CursorAcpPermissionBehavior;
  cancelled?: boolean;
  message?: string;
}

export interface CursorAcpExtensionRequest {
  requestId: CursorAcpJsonRpcId;
  sessionId: string;
  prompt: CursorPrompt;
}

export interface CursorAcpExtensionDecision {
  cancelled?: boolean;
  answer?: CursorAnswer;
}

export interface CursorAcpPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface CursorAcpSessionOptions {
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
    request: CursorAcpPermissionRequest,
  ) => Promise<CursorAcpPermissionDecision> | CursorAcpPermissionDecision;
  onExtensionRequest?: (
    request: CursorAcpExtensionRequest,
  ) => Promise<CursorAcpExtensionDecision> | CursorAcpExtensionDecision;
  onPromptStart?: () => void;
  onPromptComplete?: (result: CursorAcpPromptResult) => void;
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
  requestId?: CursorAcpJsonRpcId;
  cancelSettleTimer?: NodeJS.Timeout;
}

interface PendingPermission {
  request: CursorAcpPermissionRequest;
  responded: boolean;
}

interface PendingExtension {
  request: CursorAcpExtensionRequest;
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
export const CURSOR_ACP_AUTH_REQUIRED_MESSAGE =
  "Cursor CLI 未登录。请在本机运行 `agent login`，或设置 CURSOR_API_KEY / CURSOR_AUTH_TOKEN。";

const denyPermission = (): CursorAcpPermissionDecision => ({
  behavior: "deny",
  message: "Tool use denied by default policy. Remote approval is not configured.",
});

const cancelExtension = (): CursorAcpExtensionDecision => ({
  cancelled: true,
  answer: { type: "ask_question", outcome: "cancelled" },
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

function normalizePermissionKind(kind: string): string {
  return kind.replace(/-/g, "_");
}

function parsePermissionOptions(value: unknown): CursorAcpPermissionOption[] {
  if (!Array.isArray(value)) return [];
  const options: CursorAcpPermissionOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.optionId !== "string") continue;
    const rawKind = typeof candidate.kind === "string" ? candidate.kind : "";
    options.push({
      ...candidate,
      optionId: candidate.optionId,
      name: typeof candidate.name === "string" ? candidate.name : candidate.optionId,
      kind: normalizePermissionKind(rawKind) || rawKind,
    });
  }
  return options;
}

function normalizedOptionText(option: CursorAcpPermissionOption): string {
  return `${option.optionId} ${option.name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function isAllowOption(option: CursorAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  const kind = normalizePermissionKind(option.kind);
  return kind.startsWith("allow") || /\b(allow|approve|accept)\b/.test(text);
}

function isAlwaysOption(option: CursorAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  const kind = normalizePermissionKind(option.kind);
  return kind === "allow_always" || /\b(always|session|persist)\b/.test(text);
}

function isDenyOption(option: CursorAcpPermissionOption): boolean {
  const text = normalizedOptionText(option);
  const kind = normalizePermissionKind(option.kind);
  return kind.startsWith("reject") || /\b(reject|deny|decline|cancel|skip)\b/.test(text);
}

function optionMatchesBehavior(
  option: CursorAcpPermissionOption,
  behavior: Exclude<CursorAcpPermissionBehavior, "cancel">,
): boolean {
  if (behavior === "deny") return isDenyOption(option);
  if (behavior === "allow_always") {
    return isAllowOption(option) && isAlwaysOption(option);
  }
  return isAllowOption(option) && !isAlwaysOption(option);
}

function selectPermissionOption(
  options: CursorAcpPermissionOption[],
  behavior: Exclude<CursorAcpPermissionBehavior, "cancel">,
): CursorAcpPermissionOption | undefined {
  if (behavior === "deny") {
    return (
      options.find((option) => normalizePermissionKind(option.kind).startsWith("reject")) ??
      options.find(isDenyOption)
    );
  }

  if (behavior === "allow_always") {
    return (
      options.find((option) => normalizePermissionKind(option.kind) === "allow_always") ??
      options.find((option) => isAllowOption(option) && isAlwaysOption(option)) ??
      options.find((option) => normalizePermissionKind(option.kind) === "allow_once") ??
      options.find((option) => isAllowOption(option) && !isAlwaysOption(option))
    );
  }

  return (
    options.find((option) => normalizePermissionKind(option.kind) === "allow_once") ??
    options.find((option) => isAllowOption(option) && !isAlwaysOption(option))
  );
}

function promptResult(value: unknown): CursorAcpPromptResult {
  return isRecord(value) ? value : {};
}

function responseErrorMessage(error: Record<string, unknown>): string {
  return typeof error.message === "string" ? error.message : "Cursor ACP request failed";
}

function advertisedAuthMethods(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.authMethods)) return [];
  return result.authMethods.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    if (isRecord(candidate) && typeof candidate.id === "string") return [candidate.id];
    return [];
  });
}

function parseAskQuestionPrompt(params: Record<string, unknown>): CursorPrompt | null {
  if (!Array.isArray(params.questions)) return null;
  const questions = params.questions.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.prompt !== "string") {
      return [];
    }
    if (!Array.isArray(candidate.options)) return [];
    const options = candidate.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.id !== "string" || typeof option.label !== "string") {
        return [];
      }
      return [{ id: option.id, label: option.label }];
    });
    if (options.length === 0) return [];
    return [
      {
        id: candidate.id,
        prompt: candidate.prompt,
        options,
        ...(candidate.allowMultiple === true ? { allowMultiple: true } : {}),
      },
    ];
  });
  if (questions.length === 0) return null;
  return {
    type: "ask_question",
    ...(typeof params.toolCallId === "string" ? { toolCallId: params.toolCallId } : {}),
    ...(typeof params.title === "string" ? { title: params.title } : {}),
    questions,
  };
}

type CursorTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

function parseTodoStatus(value: unknown): CursorTodoStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

function parseTodos(value: unknown): Array<{ id: string; content: string; status: CursorTodoStatus }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos = value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.content !== "string") {
      return [];
    }
    return [{ id: candidate.id, content: candidate.content, status: parseTodoStatus(candidate.status) }];
  });
  return todos.length ? todos : undefined;
}

function parseCreatePlanPrompt(params: Record<string, unknown>): CursorPrompt | null {
  if (typeof params.plan !== "string") return null;
  const todos = parseTodos(params.todos);
  const phases = Array.isArray(params.phases)
    ? params.phases.flatMap((candidate) => {
        if (!isRecord(candidate) || typeof candidate.name !== "string") return [];
        const phaseTodos = parseTodos(candidate.todos);
        return phaseTodos ? [{ name: candidate.name, todos: phaseTodos }] : [];
      })
    : undefined;
  return {
    type: "create_plan",
    ...(typeof params.toolCallId === "string" ? { toolCallId: params.toolCallId } : {}),
    ...(typeof params.name === "string" ? { name: params.name } : {}),
    ...(typeof params.overview === "string" ? { overview: params.overview } : {}),
    plan: params.plan,
    ...(todos ? { todos } : {}),
    ...(typeof params.isProject === "boolean" ? { isProject: params.isProject } : {}),
    ...(phases?.length ? { phases } : {}),
  };
}

function wrapAuthError(error: Error): Error {
  const message = error.message.toLowerCase();
  if (
    message.includes("auth") ||
    message.includes("login") ||
    message.includes("unauthor") ||
    message.includes("token") ||
    message.includes("api key")
  ) {
    return new Error(`${CURSOR_ACP_AUTH_REQUIRED_MESSAGE} (${error.message})`);
  }
  return new Error(`${CURSOR_ACP_AUTH_REQUIRED_MESSAGE} (${error.message})`);
}

export class CursorAcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Cursor ACP ${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`);
    this.name = "CursorAcpRpcError";
  }
}

export class CursorAcpProtocolError extends Error {
  constructor(
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "CursorAcpProtocolError";
  }
}

export class CursorAcpSession {
  private child: ChildProcess | null = null;
  private stderrTail = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<CursorAcpJsonRpcId, PendingRequest>();
  private readonly pendingPermissions = new Map<CursorAcpJsonRpcId, PendingPermission>();
  private readonly pendingExtensions = new Map<CursorAcpJsonRpcId, PendingExtension>();
  private readonly cancelledResponseIds = new Set<CursorAcpJsonRpcId>();
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
  private readonly acpMode: CursorAcpMode;
  private readonly autoApprovePermissions: boolean;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly cancelAcknowledgeTimeoutMs: number;
  private readonly onUpdate?: (params: Record<string, unknown>) => void;
  private readonly onNotification?: (method: string, params: Record<string, unknown>) => void;
  private readonly onPermissionRequest: (
    request: CursorAcpPermissionRequest,
  ) => Promise<CursorAcpPermissionDecision> | CursorAcpPermissionDecision;
  private readonly onExtensionRequest?: (
    request: CursorAcpExtensionRequest,
  ) => Promise<CursorAcpExtensionDecision> | CursorAcpExtensionDecision;
  private readonly onPromptStart?: () => void;
  private readonly onPromptComplete?: (result: CursorAcpPromptResult) => void;
  private readonly onPromptError?: (error: Error) => void;
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly onProtocolError?: (error: Error, line?: string) => void;
  private readonly onProcessError?: (error: Error) => void;
  private readonly onExitCb?: (code: number) => void;

  constructor(options: CursorAcpSessionOptions = {}) {
    this.workDir = options.cwd ?? options.workDir ?? process.cwd();
    this.resumeSessionId = options.resumeSessionId;
    this.acpMode = resolveCursorAcpMode(options.permissionMode);
    this.autoApprovePermissions = cursorAcpAutoApprovesPermissions(options.permissionMode);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.cancelAcknowledgeTimeoutMs =
      options.cancelAcknowledgeTimeoutMs ?? DEFAULT_CANCEL_ACKNOWLEDGE_TIMEOUT_MS;
    this.onUpdate = options.onUpdate;
    this.onNotification = options.onNotification;
    this.onPermissionRequest = options.onPermissionRequest ?? denyPermission;
    this.onExtensionRequest = options.onExtensionRequest;
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

  getCursorSessionId(): string | null {
    return this.sessionId;
  }

  getPendingPermission(requestId: CursorAcpJsonRpcId): CursorAcpPermissionRequest | undefined {
    return this.pendingPermissions.get(requestId)?.request;
  }

  start(): number {
    if (this.child) throw new Error("Cursor ACP session has already been started");
    const command = CURSOR_PROVIDER.buildJsonCommand({ cwd: this.workDir }, process.env);
    this.child = spawnCommand(command.command, command.args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env,
    });

    this.setupStdoutParsing();
    this.setupStderrCollection();
    this.setupExitHandler();
    void this.initializeSession().catch((error) => this.rejectSessionReadyOnce(toError(error)));

    if (!this.child.pid) throw new Error("Cursor ACP failed to start: missing child pid");
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
    this.cancelPendingExtensions();
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
    if (!this.child) throw new Error("Cursor ACP session has not been started");
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
        this.appendStderr(`Cursor ACP close failed: ${toError(error).message}\n`);
      }
    }

    terminateOwnedProcessTree(child, "SIGTERM");
    const startedAt = Date.now();
    while (Date.now() - startedAt < gracePeriodMs) {
      if (!this.isChildAlive(child)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.isChildAlive(child)) terminateOwnedProcessTree(child, "SIGKILL");
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
    const initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: CLIENT_INFO,
    });

    const authMethods = advertisedAuthMethods(initializeResult);
    if (authMethods.includes("cursor_login") || authMethods.length === 0) {
      try {
        await this.request("authenticate", { methodId: "cursor_login" });
      } catch (error) {
        if (authMethods.includes("cursor_login") || this.looksLikeAuthFailure(error)) {
          throw wrapAuthError(toError(error));
        }
      }
    }

    let sessionId: string | null = null;
    if (this.resumeSessionId) {
      try {
        await this.request("session/load", {
          sessionId: this.resumeSessionId,
          cwd: this.workDir,
          mcpServers: [],
        });
        sessionId = this.resumeSessionId;
      } catch (error) {
        const created = await this.request("session/new", {
          cwd: this.workDir,
          mcpServers: [],
        });
        sessionId = this.sessionIdFromResult(created);
        if (!sessionId) throw new Error("Cursor ACP session/new did not return a session id");
        this.invokeCallback(
          () =>
            this.onNotification?.("cursor/session_load_failed", {
              requestedSessionId: this.resumeSessionId,
              sessionId,
              message: `无法恢复 Cursor 会话 ${this.resumeSessionId}，已新建会话。${toError(error).message}`,
            }),
          "session/load fallback callback failed",
        );
      }
    } else {
      const created = await this.request("session/new", {
        cwd: this.workDir,
        mcpServers: [],
      });
      sessionId = this.sessionIdFromResult(created);
    }
    if (!sessionId) throw new Error("Cursor ACP session/new did not return a session id");

    await this.request("session/set_mode", { sessionId, modeId: this.acpMode });
    this.sessionId = sessionId;
    this.onSessionId?.(sessionId);
    this.resolveSessionReadyOnce(sessionId);
  }

  private looksLikeAuthFailure(error: unknown): boolean {
    const message = toError(error).message.toLowerCase();
    return (
      message.includes("auth") ||
      message.includes("login") ||
      message.includes("unauthor") ||
      message.includes("token") ||
      message.includes("api key")
    );
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
    onRequestId?: (requestId: CursorAcpJsonRpcId) => void,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    onRequestId?.(id);
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`Cursor ACP request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      timeout?.unref?.();
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      if (!this.writeLine(payload)) {
        if (timeout) clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Cursor ACP stdin is not writable for ${method}`));
      }
    });
  }

  private writeLine(payload: Record<string, unknown>): boolean {
    if (this.transportFailure || !this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (error) {
      this.reportProtocolError(new CursorAcpProtocolError("Failed to write Cursor ACP message", error));
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
          new CursorAcpProtocolError(`Invalid Cursor ACP JSON: ${toError(error).message}`, text),
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
        new CursorAcpProtocolError("Cursor ACP message must be an object", message),
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
    this.reportProtocolError(new CursorAcpProtocolError("Unrecognized Cursor ACP message", message));
  }

  private handleResponse(id: CursorAcpJsonRpcId, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      if (this.cancelledResponseIds.delete(id)) return;
      this.reportProtocolError(
        new CursorAcpProtocolError(`Unexpected Cursor ACP response id: ${String(id)}`, message),
      );
      return;
    }
    this.pendingRequests.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(
        new CursorAcpRpcError(
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
      `Cursor ACP did not acknowledge session/cancel within ${this.cancelAcknowledgeTimeoutMs}ms; terminating the unsafe transport`,
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
    this.cancelPendingExtensions();
    pending.reject(error);
    if (this.child) terminateOwnedProcessTree(this.child, "SIGKILL");
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
    id: CursorAcpJsonRpcId;
    method: string;
    params?: unknown;
  }): void {
    if (request.method === "session/request_permission") {
      void this.handlePermissionRequest(request.id, request.params);
      return;
    }
    if (request.method === "cursor/ask_question" || request.method === "cursor/create_plan") {
      void this.handleExtensionRequest(request.id, request.method, request.params);
      return;
    }
    this.writeLine({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unsupported Cursor ACP client request: ${request.method}` },
    });
  }

  private async handlePermissionRequest(id: CursorAcpJsonRpcId, rawParams: unknown): Promise<void> {
    const params = isRecord(rawParams) ? rawParams : {};
    const incomingToolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId =
      typeof incomingToolCall.toolCallId === "string" ? incomingToolCall.toolCallId : undefined;
    const trackedToolCall = toolCallId ? (this.toolCalls.get(toolCallId) ?? {}) : {};
    const toolCall = { ...trackedToolCall, ...incomingToolCall };
    const rawInput = isRecord(incomingToolCall.rawInput)
      ? incomingToolCall.rawInput
      : trackedToolCall.rawInput;
    const request: CursorAcpPermissionRequest = {
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

    if (this.transportFailure || this.activePrompt?.cancelled) {
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }

    if (this.autoApprovePermissions) {
      const option = selectPermissionOption(request.options, "allow_always");
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "selected", optionId: "allow-always" } },
      });
      return;
    }

    const pending: PendingPermission = { request, responded: false };
    this.pendingPermissions.set(id, pending);

    let decision: CursorAcpPermissionDecision;
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
    const behavior: Exclude<CursorAcpPermissionBehavior, "cancel"> | undefined =
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
        new CursorAcpProtocolError(`Failed to respond to permission request ${String(id)}`),
      );
    }
  }

  private async handleExtensionRequest(
    id: CursorAcpJsonRpcId,
    method: "cursor/ask_question" | "cursor/create_plan",
    rawParams: unknown,
  ): Promise<void> {
    const params = isRecord(rawParams) ? rawParams : {};
    const prompt =
      method === "cursor/ask_question" ? parseAskQuestionPrompt(params) : parseCreatePlanPrompt(params);
    const cancelledResult =
      method === "cursor/ask_question"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "cancelled" } };

    if (!prompt) {
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: cancelledResult,
      });
      return;
    }

    if (this.transportFailure || this.activePrompt?.cancelled) {
      this.writeLine({ jsonrpc: "2.0", id, result: cancelledResult });
      return;
    }

    const request: CursorAcpExtensionRequest = {
      requestId: id,
      sessionId: typeof params.sessionId === "string" ? params.sessionId : (this.sessionId ?? ""),
      prompt,
    };
    const pending: PendingExtension = { request, responded: false };
    this.pendingExtensions.set(id, pending);

    let decision: CursorAcpExtensionDecision;
    try {
      decision = this.onExtensionRequest
        ? await this.onExtensionRequest(request)
        : cancelExtension();
    } catch (error) {
      decision = {
        cancelled: true,
        answer:
          method === "cursor/ask_question"
            ? { type: "ask_question", outcome: "cancelled", reason: toError(error).message }
            : { type: "create_plan", outcome: "cancelled", reason: toError(error).message },
      };
    }

    if (pending.responded) return;
    pending.responded = true;
    this.pendingExtensions.delete(id);

    const result = this.extensionResult(method, decision);
    if (!this.writeLine({ jsonrpc: "2.0", id, result })) {
      this.reportProtocolError(
        new CursorAcpProtocolError(`Failed to respond to ${method} ${String(id)}`),
      );
    }
  }

  private extensionResult(
    method: "cursor/ask_question" | "cursor/create_plan",
    decision: CursorAcpExtensionDecision,
  ): Record<string, unknown> {
    if (decision.cancelled) {
      return { outcome: { outcome: "cancelled" } };
    }
    const answer = decision.answer;
    if (method === "cursor/ask_question") {
      if (answer?.type !== "ask_question") return { outcome: { outcome: "cancelled" } };
      if (answer.outcome === "answered") {
        return {
          outcome: {
            outcome: "answered",
            answers: answer.answers ?? [],
          },
        };
      }
      return {
        outcome: {
          outcome: answer.outcome,
          ...(answer.reason ? { reason: answer.reason } : {}),
        },
      };
    }
    if (answer?.type !== "create_plan") return { outcome: { outcome: "cancelled" } };
    return {
      outcome: {
        outcome: answer.outcome,
        ...(answer.reason ? { reason: answer.reason } : {}),
      },
    };
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

  private cancelPendingExtensions(): void {
    for (const [id, pending] of this.pendingExtensions) {
      if (pending.responded) continue;
      pending.responded = true;
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    this.pendingExtensions.clear();
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
      const wrapped = new Error(`Cursor ACP failed to start: ${error.message}`);
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
          ? `Cursor ACP exited (code ${exitCode})`
          : `Cursor ACP exited before ready (code ${exitCode})`,
      );
      this.rejectAllPendingRequests(error);
      this.pendingPermissions.clear();
      this.pendingExtensions.clear();
      this.rejectSessionReadyOnce(error);
      if (exitCode !== 0) this.onProcessError?.(error);
      this.reportExit(exitCode);
    });
  }

  private invokeCallback(callback: () => void, message: string): void {
    try {
      callback();
    } catch (error) {
      this.reportProtocolError(new CursorAcpProtocolError(`${message}: ${toError(error).message}`));
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
