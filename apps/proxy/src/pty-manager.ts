import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { DataTap } from "./tap.js";

function resolveClaudePath(): string {
  const custom = process.env.CLAUDE_BIN;
  if (custom) return custom;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("claude not found in PATH. Set CLAUDE_BIN or install Claude Code: https://claude.ai/download");
  }
}

export interface PtyManagerOptions {
  claudeArgs: string[];
  tap: DataTap;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  onSessionExit?: (code: number) => void;
}

export class PtyManager {
  private child: IPty | null = null;
  private readonly claudeArgs: string[];
  private readonly tap: DataTap;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly onSessionExit?: (code: number) => void;

  constructor(options: PtyManagerOptions) {
    this.claudeArgs = options.claudeArgs;
    this.tap = options.tap;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.onSessionExit = options.onSessionExit;
  }

  start(): void {
    const cols = this.stdout.columns ?? 80;
    const rows = this.stdout.rows ?? 24;

    const claudePath = resolveClaudePath();
    const child = pty.spawn(claudePath, this.claudeArgs, {
      name: process.env.TERM ?? "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    this.child = child;

    // raw mode 仅在 stdin 为 TTY 时开启
    const isInteractive = this.stdin.isTTY === true;
    if (isInteractive) {
      this.stdin.setRawMode(true);
    }
    this.stdin.resume();

    // stdin -> PTY
    this.stdin.on("data", (data: Buffer) => {
      child.write(data.toString());
    });

    // PTY -> stdout + tap
    child.onData((data: string) => this.handleData(data));

    // resize 防抖，50ms 窗口合并快速连续的尺寸变化
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    this.stdout.on("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        child.resize(this.stdout.columns ?? 80, this.stdout.rows ?? 24);
      }, 50);
    });

    // 子进程退出，按 Unix 惯例处理信号退出码，通过回调通知调用方
    child.onExit(({ exitCode, signal }) => {
      if (isInteractive) {
        try {
          this.stdin.setRawMode(false);
        } catch {
          // stdin 可能已关闭
        }
      }
      const code = signal ? 128 + signal : exitCode;
      this.onSessionExit?.(code);
    });

    // stdin 结束时写入 EOF 控制字符到 PTY
    this.stdin.on("end", () => {
      child.write("\x04");
    });
  }

  /**
   * PTY 数据到达时的统一处理：OSC 9 修复 + 输出到终端 + 传给 tap
   *
   * start() 和 startFromFixture() 共用此方法，确保下游路径一致。
   */
  private handleData(data: string): void {
    // PTY 的 onlcr 会把 OSC 序列里的 \n 转成 \r\n，还原为 \n
    const fixed = data.replace(
      /\x1b\]9;([\s\S]*?)\x07/g,
      (_, content: string) => `\x1b]9;${content.replace(/\r\n/g, "\n")}\x07`,
    );
    this.stdout.write(fixed);
    this.tap(data);
  }

  /**
   * 从 NDJSON fixture 文件回放 PTY 数据，替代 start() 的 pty.spawn
   *
   * 按录制时间戳逐 chunk 触发 handleData()，下游路径和真实 PTY 完全一致。
   */
  async startFromFixture(fixturePath: string): Promise<void> {
    const content = readFileSync(fixturePath, "utf-8");
    const chunks: Array<{ ts: number; data: string }> = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const startTime = Date.now();
    for (const chunk of chunks) {
      const targetTime = startTime + chunk.ts;
      const waitMs = targetTime - Date.now();
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.handleData(chunk.data);
    }

    this.onSessionExit?.(0);
  }

  // 向 PTY 子进程写入数据，用于远程输入注入
  write(data: string): void {
    this.child?.write(data);
  }

  cleanup(exitCode: number): void {
    if (this.stdin.isTTY) {
      try {
        this.stdin.setRawMode(false);
      } catch {
        // stdin 可能已关闭
      }
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 子进程可能已退出
      }
    }
    this.onSessionExit?.(exitCode);
  }
}
