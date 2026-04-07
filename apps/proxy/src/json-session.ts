import { spawn, type ChildProcess } from "node:child_process";
import { LineBuffer } from "./line-buffer.js";

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

export interface JsonSessionOptions {
  workDir?: string;
  claudeArgs?: string[];
  approvalStrategy?: ApprovalStrategy;
  onEvent?: (event: StreamJsonEvent) => void;
  onExit?: (code: number) => void;
}

// 默认拒绝所有工具调用，远程审批未配置前的安全兜底
const denyAllStrategy: ApprovalStrategy = async () => ({
  behavior: "deny" as const,
  message: "Tool use denied by default policy. Remote approval not yet configured.",
});

export class JsonSession {
  private child: ChildProcess | null = null;
  private stderrChunks: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly workDir: string;
  private readonly claudeArgs: string[];
  private readonly approvalStrategy: ApprovalStrategy;
  private readonly onEvent?: (event: StreamJsonEvent) => void;
  private readonly onExitCb?: (code: number) => void;

  constructor(options: JsonSessionOptions = {}) {
    this.workDir = options.workDir ?? process.cwd();
    this.claudeArgs = options.claudeArgs ?? [];
    this.approvalStrategy = options.approvalStrategy ?? denyAllStrategy;
    this.onEvent = options.onEvent;
    this.onExitCb = options.onExit;
  }

  start(): number {
    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-prompt-tool", "stdio",
      "--verbose",
      ...this.claudeArgs,
    ];

    const filteredEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("CLAUDECODE"),
      ),
    ) as NodeJS.ProcessEnv;

    const claudeBin = process.env.CLAUDE_BIN || "claude";
    this.child = spawn(claudeBin, args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: filteredEnv,
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

      if (
        event.type === "control_request" &&
        (event.request as { subtype?: string })?.subtype === "can_use_tool"
      ) {
        this.handleControlRequest(event);
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

  private handleControlRequest(event: StreamJsonEvent): void {
    const requestId = event.request_id as string;
    const request = event.request as {
      tool_name: string;
      input: Record<string, unknown>;
    };

    this.approvalStrategy(request.tool_name, request.input).then(
      (decision) => {
        const response =
          decision.behavior === "deny"
            ? {
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: requestId,
                  response: {
                    behavior: "deny",
                    message:
                      decision.message ??
                      "Tool use denied by default policy.",
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
      },
    );
  }

  private writeToStdin(data: string): void {
    this.writeQueue = this.writeQueue.then(() => {
      return new Promise<void>((resolve, reject) => {
        if (!this.child?.stdin?.writable) {
          reject(new Error("stdin not writable"));
          return;
        }
        this.child.stdin.write(data + "\n", (err) => {
          err ? reject(err) : resolve();
        });
      });
    });
  }
}
