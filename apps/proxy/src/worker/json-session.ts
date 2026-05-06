import { spawn, type ChildProcess } from "node:child_process";
import type { z } from "zod";
import { LineBuffer } from "../ipc/line-buffer.js";
import { ControlRequestEventSchema } from "../common/stream-json-schema.js";
import {
  CLAUDE_PROVIDER,
  buildClaudeArgs,
  filterClaudeEnvVars,
  type ClaudePermissionMode,
} from "../providers/index.js";
import type { ProviderHookContext } from "../providers/index.js";

export { buildClaudeArgs, filterClaudeEnvVars };
export type { ClaudePermissionMode };

// stream-json 事件类型定义，基于 cc-connect 验证的结构
export type StreamJsonEventType =
  | "system"
  | "assistant"
  | "user"
  | "result"
  | "control_request"
  | "control_cancel_request"
  | "stream_event";

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

export class JsonSession {
  private child: ChildProcess | null = null;
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
    const command = CLAUDE_PROVIDER.buildJsonCommand(
      {
        extraArgs: this.claudeArgs,
        permissionMode: this.permissionMode,
        resumeSessionId: this.resumeSessionId,
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

  isAlive(): boolean {
    if (!this.child || !this.child.pid) return false;
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

  private setupStdoutParsing(): void {
    if (!this.child?.stdout) return;

    const lineBuffer = new LineBuffer();
    this.child.stdout.pipe(lineBuffer);

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
    if (!this.child?.stderr) return;
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    });
  }

  private setupExitHandler(): void {
    if (!this.child) return;
    this.child.on("exit", (code: number | null) => {
      this.onExitCb?.(code ?? 1);
    });
  }

  private handleControlRequest(event: z.infer<typeof ControlRequestEventSchema>): void {
    const requestId = event.request_id;
    const request = event.request;

    this.approvalStrategy(request.tool_name, request.input).then((decision) => {
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
    });
  }

  private writeToStdin(data: string): void {
    this.writeQueue = this.writeQueue.then(() => {
      return new Promise<void>((resolve, reject) => {
        if (!this.child?.stdin?.writable) {
          reject(new Error("stdin not writable"));
          return;
        }
        this.child.stdin.write(data + "\n", (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }
}
