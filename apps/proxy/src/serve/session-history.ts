import { readdir, stat, access, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  applySessionHistoryMetadata,
  readSessionHistoryMetadata,
} from "./session-history-metadata.js";

interface SessionHistoryEntry {
  id: string;
  title: string;
  projectDir: string;
  updatedAt: number;
  provider: "claude" | "codex";
  preferredMode?: "pty" | "json";
}

interface ScanSessionHistoryOptions {
  metadataPath?: string;
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
export async function scanSessionHistory(
  options: ScanSessionHistoryOptions = {},
): Promise<SessionHistoryEntry[]> {
  const entries = applySessionHistoryMetadata(
    [...(await scanClaudeSessionHistory()), ...(await scanCodexSessionHistory())],
    readSessionHistoryMetadata(options.metadataPath),
  );
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  // 按 provider + title + projectDir 去重，resume 产生的多个 session 只保留最新的
  const seen = new Set<string>();
  const uniqueEntries = entries.filter((e) => {
    const key = `${e.provider}::${e.projectDir}::${e.title}::${e.preferredMode ?? "unknown"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return uniqueEntries;
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
  cursor?: string;
}

interface SessionMessagesPage {
  messages: SessionMessage[];
  hasMore: boolean;
  nextBefore?: string;
}

interface SessionMessagesPageOptions {
  limit?: number;
  before?: string;
}

const DEFAULT_HISTORY_PAGE_LIMIT = 50;
const MAX_HISTORY_PAGE_LIMIT = 200;
const HISTORY_READ_CHUNK_BYTES = 64 * 1024;
const HISTORY_CURSOR_PREFIX = "b:";

function normalizeHistoryPageLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_HISTORY_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_PAGE_LIMIT, Math.floor(limit)));
}

function encodeHistoryCursor(offset: number): string {
  return `${HISTORY_CURSOR_PREFIX}${Math.max(0, Math.floor(offset))}`;
}

function decodeHistoryCursor(cursor: string | undefined, fileSize: number): number {
  if (!cursor) return fileSize;
  const raw = cursor.startsWith(HISTORY_CURSOR_PREFIX)
    ? cursor.slice(HISTORY_CURSOR_PREFIX.length)
    : cursor;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fileSize;
  return Math.min(parsed, fileSize);
}

// claudeSessionId 由 claude 自身生成（UUID），但既然落盘后会被拼进文件路径，
// 防御性正则确保任何来源的不规范值都不会越过 ~/.claude/projects/<dir>/ 边界。
// 允许字母数字、下划线、短横线，足以覆盖 UUID 与历史 fixture，禁止 . / \ \0 等路径字符。
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

async function findClaudeSessionFile(claudeSessionId: string): Promise<string | null> {
  if (!SAFE_SESSION_ID_PATTERN.test(claudeSessionId)) return null;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(claudeProjectsDir());
  } catch {
    return null;
  }

  for (const encodedDir of projectDirs) {
    const filePath = join(claudeProjectsDir(), encodedDir, `${claudeSessionId}.jsonl`);
    try {
      await access(filePath);
      return filePath;
    } catch {
      continue;
    }
  }

  return null;
}

function extractConversationMessageFromJson(obj: unknown): Omit<SessionMessage, "cursor"> | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as {
    type?: unknown;
    isMeta?: unknown;
    message?: unknown;
    timestamp?: unknown;
  };
  if (record.type === "user") {
    if (record.isMeta) return null;
    const text = extractConversationText(record.message);
    if (!text) return null;
    const ts =
      typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : undefined;
    return { role: "user", text, timestamp: ts };
  }
  if (record.type === "assistant") {
    const text = extractConversationText(record.message);
    if (!text) return null;
    const ts =
      typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : undefined;
    return { role: "assistant", text, timestamp: ts };
  }
  return null;
}

function splitLineSegments(
  block: Buffer,
  blockStart: number,
): Array<{ start: number; line: Buffer }> {
  const segments: Array<{ start: number; line: Buffer }> = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 10) continue;
    segments.push({ start: blockStart + start, line: block.subarray(start, i) });
    start = i + 1;
  }
  segments.push({ start: blockStart + start, line: block.subarray(start) });
  return segments;
}

function stripCarriageReturn(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, -1) : line;
}

async function readSessionMessagesPageFromFile(
  filePath: string,
  options: SessionMessagesPageOptions = {},
): Promise<SessionMessagesPage> {
  const limit = normalizeHistoryPageLimit(options.limit);
  const file = await open(filePath, "r");
  try {
    const fileStat = await file.stat();
    const endOffset = decodeHistoryCursor(options.before, fileStat.size);
    if (endOffset <= 0) return { messages: [], hasMore: false };

    let position = endOffset;
    let carry: Buffer = Buffer.alloc(0);
    const collected: SessionMessage[] = [];

    while (position > 0 && collected.length <= limit) {
      const readSize = Math.min(HISTORY_READ_CHUNK_BYTES, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await file.read(chunk, 0, readSize, position);

      const block = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      const segments = splitLineSegments(block, position);
      const firstCompleteIndex = position > 0 ? 1 : 0;
      carry = position > 0 ? (segments[0]?.line ?? Buffer.alloc(0)) : Buffer.alloc(0);

      for (let i = segments.length - 1; i >= firstCompleteIndex; i -= 1) {
        const segment = segments[i];
        if (!segment) continue;
        const line = stripCarriageReturn(segment.line);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line.toString("utf-8"));
          const message = extractConversationMessageFromJson(parsed);
          if (!message) continue;
          collected.push({ ...message, cursor: encodeHistoryCursor(segment.start) });
          if (collected.length > limit) break;
        } catch {
          /* skip malformed lines */
        }
      }
    }

    const page = collected.slice(0, limit).reverse();
    const hasMore = collected.length > limit;
    return {
      messages: page,
      hasMore,
      ...(hasMore && page[0]?.cursor ? { nextBefore: page[0].cursor } : {}),
    };
  } finally {
    await file.close();
  }
}

// 从 JSONL 文件中提取 user/assistant 对话消息用于恢复时展示历史
export async function readSessionMessages(claudeSessionId: string): Promise<SessionMessage[]> {
  const filePath = await findClaudeSessionFile(claudeSessionId);
  if (!filePath) return [];

  const messages: SessionMessage[] = [];
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = extractConversationMessageFromJson(JSON.parse(line));
        if (message) messages.push(message);
      } catch {
        /* skip */
      }
    });

    rl.on("close", () => resolve(messages));
    rl.on("error", () => resolve(messages));
  });
}

export async function readSessionMessagesPage(
  claudeSessionId: string,
  options: SessionMessagesPageOptions = {},
): Promise<SessionMessagesPage> {
  const filePath = await findClaudeSessionFile(claudeSessionId);
  if (!filePath) return { messages: [], hasMore: false };
  return readSessionMessagesPageFromFile(filePath, options);
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

function normalizeConversationText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed;
}

// 对话正文恢复必须保留换行和 Markdown 结构；不能复用标题归一化逻辑。
function extractConversationText(msg: unknown): string | null {
  if (typeof msg === "string") {
    const cmd = extractSlashCommand(msg);
    if (cmd) return cmd;
    return normalizeConversationText(msg);
  }

  if (msg && typeof msg === "object" && "content" in msg) {
    const content = (msg as { content: unknown }).content;
    if (typeof content === "string") {
      const cmd = extractSlashCommand(content);
      if (cmd) return cmd;
      return normalizeConversationText(content);
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
        )
        .map((b: { text: string }) => b.text);
      return normalizeConversationText(texts.join("\n"));
    }
  }

  if (Array.isArray(msg)) {
    const texts = msg
      .filter(
        (b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string",
      )
      .map((b: { text: string }) => b.text);
    return normalizeConversationText(texts.join("\n"));
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
