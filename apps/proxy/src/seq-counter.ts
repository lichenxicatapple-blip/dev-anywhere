import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { sessionPaths } from "./paths.js";

/**
 * 轻量级 per-session seq 计数器，持久化到文件
 *
 * 仅存储一个递增整数，proxy 重启后能接续。
 * 替代 EventStore 的全部 seq 管理功能。
 */
export class SeqCounter {
  private seq: number = 0;
  private readonly filePath: string;

  constructor(sessionId: string, baseDir?: string) {
    const dir = baseDir ?? sessionPaths(sessionId).dir;
    mkdirSync(dir, { recursive: true });
    this.filePath = `${dir}/seq`;
    this.load();
  }

  next(): number {
    this.seq++;
    this.save();
    return this.seq;
  }

  current(): number {
    return this.seq;
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, "utf-8").trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.seq = parsed;
        }
      }
    } catch {
      // 文件损坏或不可读，从 0 开始
    }
  }

  private save(): void {
    writeFileSync(this.filePath, String(this.seq));
  }
}
