import { spawn, type ChildProcess } from "node:child_process";
import type { z } from "zod";
import { LineBuffer } from "../ipc/line-buffer.js";
import { ControlRequestEventSchema } from "../common/stream-json-schema.js";
import { CLAUDE_PROVIDER, type ClaudePermissionMode } from "../providers/index.js";
import type { ProviderHookContext } from "../providers/index.js";

export type { ClaudePermissionMode };

// stream-json event types observed from provider output.
export type StreamJsonEventType =
  | "system"
  | "assistant"
  | "user"
  | "result"
  | "control_request"
  | "control_cancel_request"
  | "stream_event"
  | "codex_app_server";

export interface StreamJsonEvent {
  type: StreamJsonEventType;
  [key: string]: unknown;
}

export type ApprovalStrategy = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow" | "deny"; message?: string }>;

interface JsonSessionOptions {
  workDir?: string;
  claudeArgs?: string[];
  approvalStrategy?: ApprovalStrategy;
  onEvent?: (event: StreamJsonEvent) => void;
  onExit?: (code: number) => void;
  cwd?: string;
  resumeSessionId?: string;
  permissionMode?: ClaudePermissionMode;
  includePartialMessages?: boolean;
  hook?: ProviderHookContext;
}

// 默认拒绝所有工具调用，远程审批未配置前的安全兜底
const denyAllStrategy: ApprovalStrategy = async () => ({
  behavior: "deny" as const,
  message: "Tool use denied by default policy. Remote approval not yet configured.",
});

// 会话级别的工具白名单，用户点击"全部允许"后同名工具自动审批
export class ToolWhitelist {
  private allowed = new Set<string>();

  has(toolName: string): boolean {
    return this.allowed.has(toolName);
  }

  add(toolName: string): void {
    this.allowed.add(toolName);
  }

  clear(): void {
    this.allowed.clear();
  }
}

// 创建中继转发审批策略，先检查白名单再转发到 relay
export function createRelayApprovalStrategy(
  whitelist: ToolWhitelist,
  forwardToRelay: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ behavior: "allow" | "deny"; message?: string }>,
): ApprovalStrategy {
  return async (toolName, input) => {
    if (whitelist.has(toolName)) {
      return { behavior: "allow", message: "Auto-approved by session whitelist" };
    }
    return forwardToRelay(toolName, input);
  };
}

const editToolNames = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function createPermissionModeApprovalStrategy(
  permissionMode: ClaudePermissionMode | undefined,
  fallback: ApprovalStrategy,
): ApprovalStrategy {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return async () => ({ behavior: "allow", message: "Auto-approved by permission mode" });
    case "acceptEdits":
      return async (toolName, input) => {
        if (editToolNames.has(toolName)) {
          return { behavior: "allow", message: "Auto-approved edit by permission mode" };
        }
        return fallback(toolName, input);
      };
    case "plan":
      return async () => ({
        behavior: "deny",
        message: "Tool use denied by plan mode.",
      });
    default:
      return fallback;
  }
}

export class JsonSession {
  private child: ChildProcess | null = null;
  private readonly interruptedChildren = new WeakSet<ChildProcess>();
  private readonly interruptedExitResolvers = new WeakMap<ChildProcess, () => void>();
  private stderrChunks: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private claudeSessionId: string | null = null;
  private readonly workDir: string;
  private readonly claudeArgs: string[];
  private readonly approvalStrategy: ApprovalStrategy;
  private readonly onEvent?: (event: StreamJsonEvent) => void;
  private readonly onExitCb?: (code: number) => void;
  private readonly resumeSessionId?: string;
  private readonly permissionMode?: ClaudePermissionMode;
  private readonly includePartialMessages: boolean;
  private readonly hook?: ProviderHookContext;

  constructor(options: JsonSessionOptions = {}) {
    this.workDir = options.cwd ?? options.workDir ?? process.cwd();
    this.claudeArgs = options.claudeArgs ?? [];
    this.approvalStrategy = options.approvalStrategy ?? denyAllStrategy;
    this.onEvent = options.onEvent;
    this.onExitCb = options.onExit;
    this.resumeSessionId = options.resumeSessionId;
    this.permissionMode = options.permissionMode;
    this.includePartialMessages = options.includePartialMessages ?? false;
    this.hook = options.hook;
  }

  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  start(): number {
    return this.startChild(this.resumeSessionId);
  }

  private startChild(resumeSessionId?: string): number {
    const command = CLAUDE_PROVIDER.buildJsonCommand(
      {
        extraArgs: this.claudeArgs,
        permissionMode: this.permissionMode,
        resumeSessionId,
        includePartialMessages: this.includePartialMessages,
        hook: this.hook,
      },
      process.env,
    );

    this.child = spawn(command.command, command.args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env,
    });

    this.setupStdoutParsing();
    this.setupStderrCollection();
    this.setupExitHandler();

    return this.child.pid!;
  }

  sendMessage(content: string): void {
    const message = {
      type: "user",
      message: { role: "user", content },
    };
    this.writeToStdin(JSON.stringify(message));
  }

  async stop(gracePeriodMs = 5000): Promise<void> {
    if (!this.child || !this.isAlive()) return;

    this.child.kill("SIGTERM");

    const start = Date.now();
    while (Date.now() - start < gracePeriodMs) {
      if (!this.isAlive()) return;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (this.isAlive()) {
      this.child.kill("SIGKILL");
    }
  }

  async interruptCurrentTurn(gracePeriodMs = 5000): Promise<boolean> {
    const child = this.child;
    if (!child || !this.isChildAlive(child)) return false;

    this.interruptedChildren.add(child);
    const drained = new Promise<void>((resolve) => {
      this.interruptedExitResolvers.set(child, resolve);
    });

    const signaled = child.kill("SIGINT");
    if (!signaled) {
      this.interruptedChildren.delete(child);
      this.interruptedExitResolvers.delete(child);
      return false;
    }

    const start = Date.now();
    while (Date.now() - start < gracePeriodMs) {
      if (!this.isChildAlive(child)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.isChildAlive(child)) {
      child.kill("SIGKILL");
    }

    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (this.child === child) this.child = null;
    this.startChild(this.claudeSessionId ?? this.resumeSessionId ?? undefined);
    return true;
  }

  isAlive(): boolean {
    return this.child ? this.isChildAlive(this.child) : false;
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

  getStderr(): string {
    return this.stderrChunks.join("");
  }

  private setupStdoutParsing(): void {
    const child = this.child;
    if (!child?.stdout) return;

    const lineBuffer = new LineBuffer();
    child.stdout.pipe(lineBuffer);

    lineBuffer.on("data", (line: Buffer | string) => {
      const str = typeof line === "string" ? line : line.toString();
      let event: StreamJsonEvent;
      try {
        event = JSON.parse(str) as StreamJsonEvent;
      } catch {
        // 非 JSON 行直接跳过，verbose 模式会输出调试日志
        return;
      }

      // 从 system 事件中捕获 Claude 会话 ID 用于后续 resume
      if (event.type === "system" && typeof event.session_id === "string") {
        this.claudeSessionId = event.session_id;
      }

      if (event.type === "control_request") {
        // schema parse 失败说明 CLI 协议漂移，调用方必须感知而不是静默吃掉
        const parsed = ControlRequestEventSchema.safeParse(event);
        if (!parsed.success) {
          console.error(
            "[json-session] control_request shape mismatch; skipping approval",
            parsed.error.issues.slice(0, 3),
          );
          return;
        }
        this.handleControlRequest(parsed.data);
        return;
      }

      this.onEvent?.(event);
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
    // child 'exit' 触发时, stdout pipe 里可能还堆着最后几行 stream-json (含 'result'
    // event → turn_complete 信号)。直接 fire onExit → caller process.exit(0) 会切断
    // pipe, 这些行永远不解析, session 永卡 WORKING。等 stdout 'end' (所有 chunk 流过
    // LineBuffer) + child 'exit' 都到, 才 fire onExit。
    let stdoutEnded = false;
    let exitCode: number | null = null;
    let exited = false;
    let fired = false;
    const fireOnce = (): void => {
      if (fired || !exited || !stdoutEnded) return;
      fired = true;
      if (this.interruptedChildren.has(child)) {
        this.interruptedChildren.delete(child);
        this.interruptedExitResolvers.get(child)?.();
        this.interruptedExitResolvers.delete(child);
        return;
      }
      this.onExitCb?.(exitCode ?? 1);
    };
    child.stdout?.on("end", () => {
      stdoutEnded = true;
      fireOnce();
    });
    child.on("error", (err: Error) => {
      this.stderrChunks.push(`Process failed to start: ${err.message}\n`);
      exitCode = 1;
      exited = true;
      stdoutEnded = true;
      fireOnce();
    });
    child.on("exit", (code: number | null) => {
      exitCode = code;
      exited = true;
      // 兜底: child 异常退出且 stdout 卡住时 'end' 永不到, 1s 后强制 fire 防 session 永挂
      setTimeout(() => {
        stdoutEnded = true;
        fireOnce();
      }, 1000).unref();
      fireOnce();
    });
  }

  private handleControlRequest(event: z.infer<typeof ControlRequestEventSchema>): void {
    const requestId = event.request_id;
    const request = event.request;

    this.approvalStrategy(request.tool_name, request.input)
      .then((decision) => {
        const response =
          decision.behavior === "deny"
            ? {
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: requestId,
                  response: {
                    behavior: "deny",
                    message: decision.message ?? "Tool use denied by default policy.",
                  },
                },
              }
            : {
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: requestId,
                  response: {
                    behavior: "allow",
                    updatedInput: {},
                  },
                },
              };

        this.writeToStdin(JSON.stringify(response));
      })
      .catch((err) => {
        // approvalStrategy 失败时若无应答，claude 会无限等待 control_response 卡死整个 turn。
        // 兜底回 deny 让 turn 继续推进；具体失败原因记到 stderr 由调用方/日志收敛。
        console.error(
          "[json-session] approval strategy rejected, fallback to deny",
          requestId,
          err instanceof Error ? err.message : err,
        );
        this.writeToStdin(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: {
                behavior: "deny",
                message: "Approval strategy failed; denied as fallback.",
              },
            },
          }),
        );
      });
  }

  private writeToStdin(data: string): void {
    // writeQueue 只承诺单调推进：单次写入失败不能让 queue 永久 rejected，否则后续 sendMessage
    // 与 control_response 全部走在 rejected promise 上立即失败，worker 表现为 stdin 静默死锁。
    this.writeQueue = this.writeQueue
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!this.child?.stdin?.writable) {
              reject(new Error("stdin not writable"));
              return;
            }
            this.child.stdin.write(data + "\n", (err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
      )
      .catch((err) => {
        console.error(
          "[json-session] writeToStdin failed",
          err instanceof Error ? err.message : err,
        );
      });
  }
}
