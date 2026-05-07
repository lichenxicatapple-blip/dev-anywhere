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
  provider: "claude" | "codex";
}

const claudeProjectsDir = (): string => join(homedir(), ".claude", "projects");
const codexSessionsDir = (): string => join(homedir(), ".codex", "sessions");
const UNTITLED_SESSION_TITLE = "未命名会话";
const MAX_HISTORY_TITLE_LENGTH = 40;
const IGNORED_SLASH_COMMANDS = new Set([
  "/clear",
  "/model",
  "/compact",
  "/help",
  "/config",
  "/logout",
]);
const XMLISH_NOISE_PREFIXES = [
  "environment",
  "system",
  "developer",
  "assistant",
  "user",
  "tool",
  "context",
];
const INTERNAL_TITLE_PATTERNS = [
  /^the following is the codex agent history\b/i,
  /^codex agent history\b/i,
  /^conversation summary\b/i,
];

// 扫描 ~/.claude/projects/ 获取 Claude Code 会话历史
// 实际目录结构: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
export async function scanSessionHistory(): Promise<SessionHistoryEntry[]> {
  const entries = [...(await scanClaudeSessionHistory()), ...(await scanCodexSessionHistory())];
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

async function scanClaudeSessionHistory(): Promise<SessionHistoryEntry[]> {
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
          title: title || UNTITLED_SESSION_TITLE,
          projectDir: cwd || "/" + encodedDir.replace(/^-/, "").split("-").join("/"),
          updatedAt: fileStat.mtimeMs,
          provider: "claude",
        });
      } catch {
        continue;
      }
    }
  }

  return entries;
}

async function scanCodexSessionHistory(): Promise<SessionHistoryEntry[]> {
  const files = await collectJsonlFiles(codexSessionsDir());
  const entries: SessionHistoryEntry[] = [];
  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      const meta = await extractCodexTitleAndCwd(filePath);
      if (!meta.id) continue;
      entries.push({
        id: meta.id,
        title: meta.title || UNTITLED_SESSION_TITLE,
        projectDir: meta.cwd || homedir(),
        updatedAt: fileStat.mtimeMs,
        provider: "codex",
      });
    } catch {
      continue;
    }
  }
  return entries;
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
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateTitle(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_HISTORY_TITLE_LENGTH
    ? `${chars.slice(0, MAX_HISTORY_TITLE_LENGTH).join("")}...`
    : text;
}

function isXmlishNoise(text: string): boolean {
  const match = text.match(/^<([A-Za-z][\w:-]*)\b/);
  if (!match) return false;
  const tag = match[1].toLowerCase();
  return XMLISH_NOISE_PREFIXES.some((prefix) => tag === prefix || tag.startsWith(`${prefix}_`));
}

export function normalizeHistoryTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = collapseWhitespace(raw);
  if (text.length < 2) return null;
  if (text.startsWith("<") || isXmlishNoise(text)) return null;
  if (INTERNAL_TITLE_PATTERNS.some((pattern) => pattern.test(text))) return null;

  const slashCommand = text.match(/^\/\S+/)?.[0];
  if (slashCommand && IGNORED_SLASH_COMMANDS.has(slashCommand)) return null;

  return truncateTitle(text);
}

function extractSlashCommand(text: string): string | null {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return normalizeHistoryTitle(args ? `${nameMatch[1]} ${args}` : nameMatch[1]);
}

function extractMessageText(msg: unknown): string | null {
  if (typeof msg === "string") {
    const cmd = extractSlashCommand(msg);
    if (cmd) return cmd;
    return normalizeHistoryTitle(msg);
  }

  if (msg && typeof msg === "object" && "content" in msg) {
    const content = (msg as { content: unknown }).content;
    if (typeof content === "string") {
      const cmd = extractSlashCommand(content);
      if (cmd) return cmd;
      return normalizeHistoryTitle(content);
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
        )
        .map((b: { text: string }) => b.text);
      const joined = texts.join("\n").trim();
      return normalizeHistoryTitle(joined);
    }
  }

  if (Array.isArray(msg)) {
    const texts = msg
      .filter(
        (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
      )
      .map((b: { text: string }) => b.text);
    const joined = texts.join("\n").trim();
    return normalizeHistoryTitle(joined);
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
          if (text) title = text;
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

async function collectJsonlFiles(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(child);
    }
  }
  return files;
}

async function extractCodexTitleAndCwd(
  filePath: string,
): Promise<{ id: string | null; title: string | null; cwd: string | null }> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    let id: string | null = null;
    let cwd: string | null = null;
    let title: string | null = null;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "session_meta" && obj.payload) {
          if (!id && typeof obj.payload.id === "string") id = obj.payload.id;
          if (!cwd && typeof obj.payload.cwd === "string") cwd = obj.payload.cwd;
        }
        if (!title && obj.type === "response_item") {
          const text = extractCodexUserText(obj.payload);
          if (text) title = text;
        }
        if (id && cwd && title) rl.close();
      } catch {
        /* skip malformed lines */
      }
    });

    rl.on("close", () => resolve({ id, title, cwd }));
    rl.on("error", () => resolve({ id, title, cwd }));
  });
}

function extractCodexUserText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const item = payload as { type?: unknown; role?: unknown; content?: unknown };
  if (item.type !== "message" || item.role !== "user") return null;
  if (typeof item.content === "string") return normalizeHistoryTitle(item.content);
  if (!Array.isArray(item.content)) return null;
  const texts = item.content
    .map((block: unknown) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "input_text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean);
  const joined = texts.join("\n").trim();
  return normalizeHistoryTitle(joined);
}
