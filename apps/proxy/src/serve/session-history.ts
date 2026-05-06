import { readdir, stat, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

interface SessionHistoryEntry {
  id: string;
  title: string;
  projectDir: string;
  updatedAt: number;
  provider: "claude";
}

const claudeProjectsDir = (): string => join(homedir(), ".claude", "projects");

// 扫描 ~/.claude/projects/ 获取 Claude Code 会话历史
// 实际目录结构: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
export async function scanSessionHistory(): Promise<SessionHistoryEntry[]> {
  const entries: SessionHistoryEntry[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(claudeProjectsDir());
  } catch {
    return [];
  }

  for (const encodedDir of projectDirs) {
    const projectPath = join(claudeProjectsDir(), encodedDir);

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(projectPath, file);
      try {
        const fileStat = await stat(filePath);
        const sessionId = file.replace(/\.jsonl$/, "");
        const { title, cwd } = await extractTitleAndCwd(filePath);

        entries.push({
          id: sessionId,
          title: title || sessionId.slice(0, 8),
          projectDir: cwd || "/" + encodedDir.replace(/^-/, "").split("-").join("/"),
          updatedAt: fileStat.mtimeMs,
          provider: "claude",
        });
      } catch {
        continue;
      }
    }
  }

  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  // 按 provider + title + projectDir 去重，resume 产生的多个 session 只保留最新的
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.provider}::${e.projectDir}::${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

// 从 JSONL 文件中提取 user/assistant 对话消息用于恢复时展示历史
export async function readSessionMessages(claudeSessionId: string): Promise<SessionMessage[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(claudeProjectsDir());
  } catch {
    return [];
  }

  // 在所有项目目录中搜索匹配的 session 文件
  for (const encodedDir of projectDirs) {
    const filePath = join(claudeProjectsDir(), encodedDir, `${claudeSessionId}.jsonl`);
    try {
      await access(filePath);
    } catch {
      continue;
    }

    const messages: SessionMessage[] = [];
    return new Promise((resolve) => {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user") {
            if (obj.isMeta) return;
            const text = extractMessageText(obj.message);
            if (!text) return;
            const ts =
              typeof obj.timestamp === "string" ? new Date(obj.timestamp).getTime() : undefined;
            messages.push({ role: "user", text, timestamp: ts });
          } else if (obj.type === "assistant") {
            const text = extractMessageText(obj.message);
            const ts =
              typeof obj.timestamp === "string" ? new Date(obj.timestamp).getTime() : undefined;
            if (text) messages.push({ role: "assistant", text, timestamp: ts });
          }
        } catch {
          /* skip */
        }
      });

      rl.on("close", () => resolve(messages));
      rl.on("error", () => resolve(messages));
    });
  }

  return [];
}

// 从 message 字段提取文本，统一处理多种格式
function extractSlashCommand(text: string): string | null {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return args ? `${nameMatch[1]} ${args}` : nameMatch[1];
}

function extractMessageText(msg: unknown): string | null {
  if (typeof msg === "string") {
    const cmd = extractSlashCommand(msg);
    if (cmd) return cmd;
    if (msg.startsWith("<")) return null;
    return msg;
  }

  if (msg && typeof msg === "object" && "content" in msg) {
    const content = (msg as { content: unknown }).content;
    if (typeof content === "string") {
      const cmd = extractSlashCommand(content);
      if (cmd) return cmd;
      if (content.startsWith("<")) return null;
      return content;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
        )
        .map((b: { text: string }) => b.text);
      const joined = texts.join("\n").trim();
      if (joined && !joined.startsWith("<")) return joined;
    }
  }

  if (Array.isArray(msg)) {
    const texts = msg
      .filter(
        (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
      )
      .map((b: { text: string }) => b.text);
    const joined = texts.join("\n").trim();
    if (joined && !joined.startsWith("<")) return joined;
  }

  return null;
}

// 从 JSONL 文件头部提取 cwd 和第一条有效用户文本消息作为标题
// cwd 从任意行的 cwd 字段获取，title 从第一条 user 消息获取
async function extractTitleAndCwd(
  filePath: string,
): Promise<{ title: string | null; cwd: string | null }> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    let resolved = false;
    let cwd: string | null = null;
    let title: string | null = null;

    rl.on("line", (line) => {
      if (resolved) return;
      if (!line.trim()) return;

      try {
        const obj = JSON.parse(line);
        if (!cwd && typeof obj.cwd === "string") {
          cwd = obj.cwd;
        }
        if (!title && obj.type === "user" && !obj.isMeta) {
          const text = extractMessageText(obj.message);
          // 跳过重置/管理类命令，它们不代表会话主题
          if (
            text &&
            text.length >= 2 &&
            !/^\/(clear|model|compact|help|config|logout)(\s|$)/.test(text)
          ) {
            title = text.slice(0, 80);
          }
        }
        if (cwd && title) {
          resolved = true;
          rl.close();
        }
      } catch {
        /* skip malformed lines */
      }
    });

    rl.on("close", () => {
      if (!resolved) resolve({ title, cwd });
      else resolve({ title, cwd });
    });
    rl.on("error", () => resolve({ title, cwd }));
  });
}
