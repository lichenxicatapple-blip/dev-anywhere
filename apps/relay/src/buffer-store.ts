import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { BufferedMessage } from "./session-buffer.js";

// per-session NDJSON 文件持久化，relay 重启后从磁盘恢复缓冲区
export class BufferStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dataDir, `${safe}.ndjson`);
  }

  append(sessionId: string, msg: BufferedMessage): void {
    appendFileSync(this.filePath(sessionId), JSON.stringify(msg) + "\n");
  }

  rewrite(sessionId: string, msgs: BufferedMessage[]): void {
    const content = msgs.map((m) => JSON.stringify(m)).join("\n") + (msgs.length ? "\n" : "");
    writeFileSync(this.filePath(sessionId), content);
  }

  delete(sessionId: string): void {
    const path = this.filePath(sessionId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  load(sessionId: string): BufferedMessage[] {
    const path = this.filePath(sessionId);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as BufferedMessage);
  }

  loadAll(): Map<string, BufferedMessage[]> {
    const result = new Map<string, BufferedMessage[]>();
    if (!existsSync(this.dataDir)) return result;
    const files = readdirSync(this.dataDir).filter((f) => f.endsWith(".ndjson"));
    for (const file of files) {
      const sessionId = file.replace(".ndjson", "");
      const msgs = this.load(sessionId);
      if (msgs.length > 0) {
        result.set(sessionId, msgs);
      }
    }
    return result;
  }
}
