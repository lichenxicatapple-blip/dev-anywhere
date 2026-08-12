import { readdir, stat, access, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { summarizeToolActivity, type SessionHistoryMessage } from "@dev-anywhere/shared";
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
// Codex 会把 AGENTS.md 指令注入到首条 user 消息的一个 input_text 块里 (以 `# AGENTS.md
// instructions for <path>` 开头), 和 <environment_context> 块并排。这些块不是用户输入,
// 若被当作标题会让同项目所有会话标题雷同, 进而在去重时相互折叠。
const CODEX_AGENTS_INSTRUCTIONS_PATTERN = /^#\s*AGENTS\.md instructions for\b/i;
const CLAUDE_CONTINUATION_SUMMARY_PATTERN =
  /^This session is being continued from a previous conversation that ran out of context\.\s+The summary below covers the earlier portion of the conversation\.\s+Summary:/i;
const TEMP_HISTORY_ROOTS = expandPathAliases([tmpdir(), "/tmp", "/private/tmp", "/var/tmp"])
  .map(normalizeAbsolutePath)
  .filter((path): path is string => path !== null);

// 扫描 ~/.claude/projects/ 获取 Claude Code 会话历史
// 实际目录结构: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
export async function scanSessionHistory(
  options: ScanSessionHistoryOptions = {},
): Promise<SessionHistoryEntry[]> {
  const entries = applySessionHistoryMetadata(
    [...(await scanClaudeSessionHistory()), ...(await scanCodexSessionHistory())],
    readSessionHistoryMetadata(options.metadataPath),
  ).filter((entry) => !isTemporaryProjectDir(entry.projectDir));
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  // 按 provider + projectDir + title 去重，resume 产生的多个 session 只保留最新的。
  // 兜底: 标题回退为「未命名会话」时改用 session id 参与去重, 避免提取不到标题的不同会话
  // 被错误折叠成一条 (真实标题相同仍按设计折叠)。
  const seen = new Set<string>();
  const uniqueEntries = entries.filter((e) => {
    const titleKey = e.title === UNTITLED_SESSION_TITLE ? `id:${e.id}` : e.title;
    const key = `${e.provider}::${e.projectDir}::${titleKey}::${e.preferredMode ?? "unknown"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return uniqueEntries;
}

function normalizeAbsolutePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  let resolved = resolve(trimmed);
  while (resolved.length > 1 && resolved.endsWith(sep)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved === sep ? null : resolved;
}

function expandPathAliases(paths: string[]): string[] {
  const aliases = new Set<string>();
  for (const path of paths) {
    aliases.add(path);
    if (path.startsWith("/var/")) aliases.add(`/private${path}`);
    if (path.startsWith("/private/var/")) aliases.add(path.slice("/private".length));
  }
  return [...aliases];
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function isTemporaryProjectDir(projectDir: string): boolean {
  const normalized = normalizeAbsolutePath(projectDir);
  if (!normalized) return false;
  return TEMP_HISTORY_ROOTS.some((root) => isPathInsideOrEqual(normalized, root));
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

type WithoutCursor<T> = T extends unknown ? Omit<T, "cursor"> : never;
type SessionMessage = SessionHistoryMessage;
type UnpositionedSessionMessage = WithoutCursor<SessionHistoryMessage>;
type ExtractedHistoryItem =
  | { kind: "message"; message: UnpositionedSessionMessage }
  | { kind: "tool-result"; toolId: string; isError: boolean };

interface SessionMessagesPage {
  messages: SessionMessage[];
  hasMore: boolean;
  nextBefore?: string;
}

interface SessionMessagesPageOptions {
  limit?: number;
  before?: string;
}

type SessionHistoryProvider = "claude" | "codex";

const DEFAULT_HISTORY_PAGE_LIMIT = 50;
const MAX_HISTORY_PAGE_LIMIT = 200;
const HISTORY_READ_CHUNK_BYTES = 64 * 1024;
const HISTORY_CURSOR_PREFIX = "b:";
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const COMPACT_HISTORY_MARKER = "上下文已压缩";

function normalizeHistoryPageLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_HISTORY_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_PAGE_LIMIT, Math.floor(limit)));
}

function encodeHistoryCursor(offset: number, itemIndex = 0): string {
  const base = `${HISTORY_CURSOR_PREFIX}${Math.max(0, Math.floor(offset))}`;
  return itemIndex > 0 ? `${base}:${itemIndex}` : base;
}

function decodeHistoryCursor(cursor: string | undefined, fileSize: number): number {
  if (!cursor) return fileSize;
  const raw = cursor.startsWith(HISTORY_CURSOR_PREFIX)
    ? cursor.slice(HISTORY_CURSOR_PREFIX.length)
    : cursor;
  const parsed = Number(raw.match(/^\d+/u)?.[0]);
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

async function findCodexSessionFile(codexSessionId: string): Promise<string | null> {
  if (!SAFE_SESSION_ID_PATTERN.test(codexSessionId)) return null;

  const files = await collectJsonlFiles(codexSessionsDir());
  const filenameMatch = files.find((filePath) => filePath.endsWith(`${codexSessionId}.jsonl`));
  if (filenameMatch) return filenameMatch;

  for (const filePath of files) {
    try {
      const meta = await extractCodexTitleAndCwd(filePath);
      if (meta.id === codexSessionId) return filePath;
    } catch {
      continue;
    }
  }

  return null;
}

async function findSessionFile(
  sessionId: string,
  provider?: SessionHistoryProvider,
): Promise<string | null> {
  if (provider === "claude") return findClaudeSessionFile(sessionId);
  if (provider === "codex") return findCodexSessionFile(sessionId);
  return (await findClaudeSessionFile(sessionId)) ?? (await findCodexSessionFile(sessionId));
}

function historyTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function normalizeHistoryToolName(name: string): string {
  switch (name) {
    case "exec_command":
    case "shell":
    case "shell_command":
      return "Bash";
    case "apply_patch":
      return "Patch";
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "search_query":
      return "WebSearch";
    case "view_image":
      return "ViewImage";
    case "update_plan":
      return "TodoWrite";
    case "web__run":
      return "Web";
    default:
      return name;
  }
}

interface NormalizedHistoryToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
}

function decodeJavascriptStringLiteral(source: string): string | null {
  const quote = source[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || source.at(-1) !== quote) return null;
  if (quote === "`" && source.includes("${")) return null;

  let result = "";
  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    index += 1;
    if (index >= source.length - 1) return null;
    const escaped = source[index];
    switch (escaped) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "v":
        result += "\v";
        break;
      case "0":
        result += "\0";
        break;
      case "\n":
        break;
      case "\r":
        if (source[index + 1] === "\n") index += 1;
        break;
      default:
        result += escaped;
        break;
    }
  }
  return result;
}

function findJavascriptStringLiteralEnd(source: string, start: number): number | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return null;
}

function findJavascriptValueEnd(source: string, start: number): number {
  const stack: string[] = [];
  let quote = "";
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      if (stack.length === 0) return index;
      stack.pop();
      continue;
    }
    if ((character === "," || character === ";") && stack.length === 0) return index;
  }
  return source.length;
}

function parseJavascriptPrimitive(source: string): unknown {
  const value = source.trim();
  const stringValue = decodeJavascriptStringLiteral(value);
  if (stringValue !== null) return stringValue;
  if (value.startsWith("[")) {
    const arrayValue = parseJavascriptArrayLiteral(value, 0);
    if (arrayValue) return arrayValue;
  }
  if (value.startsWith("{")) {
    const objectValue = parseJavascriptObjectLiteral(value, 0);
    if (objectValue) return objectValue;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return Number(value);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseJavascriptArrayLiteral(source: string, start: number): unknown[] | null {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] !== "[") return null;
  index += 1;
  const result: unknown[] = [];

  while (index < source.length) {
    while (/[\s,]/u.test(source[index] ?? "")) index += 1;
    if (source[index] === "]") return result;
    const valueEnd = findJavascriptValueEnd(source, index);
    result.push(parseJavascriptPrimitive(source.slice(index, valueEnd)));
    index = valueEnd;
    if (source[index] === "]") return result;
    if (source[index] !== ",") return null;
    index += 1;
  }
  return null;
}

function parseJavascriptObjectLiteral(
  source: string,
  start: number,
): Record<string, unknown> | null {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] !== "{") return null;
  index += 1;
  const result: Record<string, unknown> = {};

  while (index < source.length) {
    while (/[\s,]/u.test(source[index] ?? "")) index += 1;
    if (source[index] === "}") return result;

    let key: string;
    if (source[index] === '"' || source[index] === "'") {
      const keyEnd = findJavascriptStringLiteralEnd(source, index);
      if (keyEnd === null) return null;
      const decodedKey = decodeJavascriptStringLiteral(source.slice(index, keyEnd));
      if (decodedKey === null) return null;
      key = decodedKey;
      index = keyEnd;
    } else {
      const keyMatch = source.slice(index).match(/^[$A-Z_a-z][$\w]*/u);
      if (!keyMatch) return null;
      key = keyMatch[0];
      index += key.length;
    }
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (source[index] === "," || source[index] === "}") {
      result[key] = undefined;
      if (source[index] === "}") return result;
      index += 1;
      continue;
    }
    if (source[index] !== ":") return null;
    index += 1;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    const valueEnd = findJavascriptValueEnd(source, index);
    result[key] = parseJavascriptPrimitive(source.slice(index, valueEnd));
    index = valueEnd;
    if (source[index] === "}") return result;
    if (source[index] !== ",") return null;
    index += 1;
  }
  return null;
}

function resolveJavascriptVariable(input: string, variableName: string): unknown {
  if (!/^[$A-Z_a-z][$\w]*$/u.test(variableName)) return undefined;
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${variableName}\\s*=\\s*`, "u").exec(
    input,
  );
  if (assignment?.index === undefined) return undefined;
  const valueStart = assignment.index + assignment[0].length;
  const valueEnd =
    findJavascriptStringLiteralEnd(input, valueStart) ?? findJavascriptValueEnd(input, valueStart);
  return parseJavascriptPrimitive(input.slice(valueStart, valueEnd));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function batchCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (Array.isArray(item)) {
      const command = item.find((entry, index) => index > 0 && typeof entry === "string");
      return typeof command === "string" ? [command] : [];
    }
    const record = asRecord(item);
    const command = record && (record.command ?? record.cmd);
    return typeof command === "string" ? [command] : [];
  });
}

function findJavascriptToolCall(
  source: string,
): { toolName: string; argumentsStart: number } | null {
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) return null;
      index = newline;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd < 0) return null;
      index = commentEnd + 1;
      continue;
    }
    if (!source.startsWith("tools.", index)) continue;
    const nameStart = index + "tools.".length;
    const nameMatch = source.slice(nameStart).match(/^[$A-Z_a-z][$\w]*/u);
    if (!nameMatch) continue;
    let argumentsStart = nameStart + nameMatch[0].length;
    while (/\s/u.test(source[argumentsStart] ?? "")) argumentsStart += 1;
    if (source[argumentsStart] !== "(") continue;
    return { toolName: nameMatch[0], argumentsStart: argumentsStart + 1 };
  }
  return null;
}

function decodeCodexExecInput(input: string): NormalizedHistoryToolCall | null {
  const call = findJavascriptToolCall(input);
  if (!call) return null;
  const { argumentsStart, toolName: nestedToolName } = call;
  const argumentEnd = findJavascriptValueEnd(input, argumentsStart);
  const argument = input.slice(argumentsStart, argumentEnd).trim();
  let parameters = parseJavascriptObjectLiteral(input, argumentsStart);
  if (!parameters && /^[$A-Z_a-z][$\w]*$/u.test(argument)) {
    parameters = asRecord(resolveJavascriptVariable(input, argument));
  }

  if (nestedToolName === "apply_patch") {
    let content = typeof parameters?.content === "string" ? parameters.content : "";
    if (!content && /^[$A-Z_a-z][$\w]*$/u.test(argument)) {
      const assignment = new RegExp(`\\b(?:const|let|var)\\s+${argument}\\s*=\\s*`, "u").exec(
        input,
      );
      if (assignment?.index !== undefined) {
        const valueStart = assignment.index + assignment[0].length;
        const valueEnd =
          findJavascriptStringLiteralEnd(input, valueStart) ??
          findJavascriptValueEnd(input, valueStart);
        const value = parseJavascriptPrimitive(input.slice(valueStart, valueEnd));
        if (typeof value === "string") content = value;
      }
    }
    if (!content) return { toolName: "Patch", parameters: {} };
    const paths = Array.from(
      content.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gmu),
      (match) => match[1],
    );
    return { toolName: "Patch", parameters: { content, ...(paths.length ? { paths } : {}) } };
  }

  if (nestedToolName === "exec_command" && !parameters) {
    const commands = batchCommands(resolveJavascriptVariable(input, "cmds"));
    if (commands.length > 0) return { toolName: "BashBatch", parameters: { commands } };
    return { toolName: "Bash", parameters: {} };
  }

  if (!parameters) {
    return { toolName: normalizeHistoryToolName(nestedToolName), parameters: {} };
  }

  if (nestedToolName === "exec_command") {
    const command = typeof parameters.cmd === "string" ? parameters.cmd : "";
    if (!command) {
      const commands = batchCommands(resolveJavascriptVariable(input, "cmds"));
      if (commands.length > 0) return { toolName: "BashBatch", parameters: { commands } };
      return { toolName: "Bash", parameters: {} };
    }
    const normalized: Record<string, unknown> = { ...parameters, command };
    delete normalized.cmd;
    return { toolName: "Bash", parameters: normalized };
  }

  if (nestedToolName === "write_stdin") {
    const chars = typeof parameters.chars === "string" ? parameters.chars : "";
    return {
      toolName: chars ? "ProcessInput" : "ProcessWait",
      parameters: chars ? { ...parameters, input: chars } : parameters,
    };
  }

  if (nestedToolName === "view_image" && typeof parameters.path !== "string") {
    const paths = stringArray(resolveJavascriptVariable(input, "paths"));
    if (paths.length > 0) return { toolName: "ViewImageBatch", parameters: { paths } };
  }

  if (nestedToolName === "update_plan" && parameters.plan === undefined) {
    const plan = resolveJavascriptVariable(input, "plan");
    return {
      toolName: "TodoWrite",
      parameters: plan === undefined ? {} : { plan },
    };
  }

  return { toolName: normalizeHistoryToolName(nestedToolName), parameters };
}

function normalizeHistoryToolParameters(
  rawToolName: string,
  input: unknown,
): Record<string, unknown> {
  const parameters = parseToolInput(input);
  const toolName = normalizeHistoryToolName(rawToolName);
  if (toolName === "Bash" && typeof parameters.command !== "string") {
    const command = typeof parameters.cmd === "string" ? parameters.cmd : undefined;
    if (command) {
      const rest = { ...parameters };
      delete rest.cmd;
      return { ...rest, command };
    }
    if (typeof input === "string" && input.trim()) {
      try {
        JSON.parse(input);
      } catch {
        return { ...parameters, command: input };
      }
    }
  }
  if (toolName === "Patch" && typeof input === "string" && !parameters.content) {
    return { ...parameters, content: input };
  }
  return parameters;
}

function normalizeHistoryToolCall(rawToolName: string, input: unknown): NormalizedHistoryToolCall {
  if (rawToolName === "exec" && typeof input === "string") {
    const decoded = decodeCodexExecInput(input);
    if (decoded) return decoded;
    if (/\btools\./u.test(input)) {
      return { toolName: "ToolScript", parameters: {} };
    }
  }
  const toolName = normalizeHistoryToolName(rawToolName);
  return { toolName, parameters: normalizeHistoryToolParameters(rawToolName, input) };
}

function toolUseHistoryItem(
  toolId: string,
  rawToolName: string,
  input: unknown,
  timestamp?: number,
): ExtractedHistoryItem | null {
  if (!toolId || !rawToolName) return null;
  const { toolName, parameters } = normalizeHistoryToolCall(rawToolName, input);
  return {
    kind: "message",
    message: {
      role: "activity",
      text: summarizeToolActivity(toolName, parameters),
      toolId,
      toolName,
      parameters,
      status: "running",
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
  };
}

function extractClaudeContentItems(
  role: "user" | "assistant",
  content: unknown,
  timestamp?: number,
): ExtractedHistoryItem[] {
  if (typeof content === "string") {
    const payload = extractConversationString(content);
    return payload
      ? [
          {
            kind: "message",
            message: {
              role: payload.role ?? role,
              text: payload.text,
              ...(timestamp !== undefined ? { timestamp } : {}),
            },
          },
        ]
      : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ExtractedHistoryItem[] = [];
  const pushTextMessage = (payload: ConversationPayload): void => {
    const messageRole = payload.role ?? role;
    const previous = items.at(-1);
    if (
      previous?.kind === "message" &&
      previous.message.role !== "activity" &&
      previous.message.role === messageRole
    ) {
      previous.message = {
        ...previous.message,
        text: `${previous.message.text}\n${payload.text}`,
      };
      return;
    }
    items.push({
      kind: "message",
      message: {
        role: messageRole,
        text: payload.text,
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
    });
  };
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const payload = extractConversationString(block.text);
      if (payload) pushTextMessage(payload);
      continue;
    }
    if (
      role === "assistant" &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      const item = toolUseHistoryItem(block.id, block.name, block.input, timestamp);
      if (item) items.push(item);
      continue;
    }
    if (role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      items.push({
        kind: "tool-result",
        toolId: block.tool_use_id,
        isError: block.is_error === true,
      });
    }
  }
  return items;
}

function extractConversationItemsFromJson(obj: unknown): ExtractedHistoryItem[] {
  if (!obj || typeof obj !== "object") return [];
  const record = obj as {
    type?: unknown;
    isMeta?: unknown;
    message?: unknown;
    timestamp?: unknown;
    payload?: unknown;
  };
  const timestamp = historyTimestamp(record.timestamp);
  if (record.type === "event_msg") {
    const payload =
      record.payload && typeof record.payload === "object"
        ? (record.payload as { type?: unknown; message?: unknown })
        : null;
    if (!payload || typeof payload.message !== "string") return [];
    const role =
      payload.type === "user_message"
        ? "user"
        : payload.type === "agent_message"
          ? "assistant"
          : null;
    if (!role) return [];
    const text = normalizeConversationText(payload.message);
    if (!text) return [];
    return [
      {
        kind: "message",
        message: { role, text, ...(timestamp !== undefined ? { timestamp } : {}) },
      },
    ];
  }
  if (record.type === "response_item") {
    const payload = asRecord(record.payload);
    if (!payload || typeof payload.type !== "string") return [];
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const toolId =
        typeof payload.call_id === "string"
          ? payload.call_id
          : typeof payload.id === "string"
            ? payload.id
            : "";
      const toolName = typeof payload.name === "string" ? payload.name : "";
      const input = payload.arguments ?? payload.input;
      const item = toolUseHistoryItem(toolId, toolName, input, timestamp);
      return item ? [item] : [];
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const toolId = typeof payload.call_id === "string" ? payload.call_id : "";
      return toolId ? [{ kind: "tool-result", toolId, isError: payload.status === "failed" }] : [];
    }
    return [];
  }
  if (record.type === "user") {
    if (record.isMeta) return [];
    const message = asRecord(record.message);
    return extractClaudeContentItems("user", message?.content ?? record.message, timestamp);
  }
  if (record.type === "assistant") {
    const message = asRecord(record.message);
    return extractClaudeContentItems("assistant", message?.content ?? record.message, timestamp);
  }
  return [];
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
    const toolResults = new Map<string, boolean>();

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
          const items = extractConversationItemsFromJson(parsed);
          for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
            const item = items[itemIndex];
            if (!item) continue;
            if (item.kind === "tool-result") {
              toolResults.set(item.toolId, item.isError);
              continue;
            }
            const message =
              item.message.role === "activity"
                ? {
                    ...item.message,
                    status: toolResults.has(item.message.toolId)
                      ? toolResults.get(item.message.toolId)
                        ? ("error" as const)
                        : ("done" as const)
                      : ("running" as const),
                  }
                : item.message;
            collected.push({
              ...message,
              cursor: encodeHistoryCursor(segment.start, itemIndex),
            });
            if (collected.length > limit) break;
          }
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
export async function readSessionMessages(
  sessionId: string,
  provider?: SessionHistoryProvider,
): Promise<SessionMessage[]> {
  const filePath = await findSessionFile(sessionId, provider);
  if (!filePath) return [];

  const messages: SessionMessage[] = [];
  const toolMessageIndexes = new Map<string, number>();
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const items = extractConversationItemsFromJson(JSON.parse(line));
        for (const item of items) {
          if (item.kind === "tool-result") {
            const messageIndex = toolMessageIndexes.get(item.toolId);
            const message = messageIndex !== undefined ? messages[messageIndex] : undefined;
            if (messageIndex !== undefined && message?.role === "activity") {
              messages[messageIndex] = {
                ...message,
                status: item.isError ? "error" : "done",
              };
            }
            continue;
          }
          if (item.message.role === "activity") {
            toolMessageIndexes.set(item.message.toolId, messages.length);
          }
          messages.push(item.message);
        }
      } catch {
        /* skip */
      }
    });

    rl.on("close", () => resolve(messages));
    rl.on("error", () => resolve(messages));
  });
}

export async function readSessionMessagesPage(
  sessionId: string,
  options: SessionMessagesPageOptions = {},
  provider?: SessionHistoryProvider,
): Promise<SessionMessagesPage> {
  const filePath = await findSessionFile(sessionId, provider);
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

function isClaudeContinuationSummary(text: string): boolean {
  return CLAUDE_CONTINUATION_SUMMARY_PATTERN.test(text.trimStart());
}

export function normalizeHistoryTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = collapseWhitespace(raw);
  if (text.length < 2) return null;
  if (isClaudeContinuationSummary(text)) return null;
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

function isCommandEnvelope(text: string): boolean {
  return /<command-name>[^<]+<\/command-name>/.test(text);
}

function isLocalCommandEnvelope(text: string): boolean {
  return /<\/?local-command-(?:stdout|stderr)>/.test(text);
}

function normalizeLocalCommandText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/<\/?local-command-(?:stdout|stderr)>/g, "")
    .trim();
}

interface ConversationPayload {
  role?: "user" | "assistant" | "system";
  text: string;
}

function extractLocalCommandHistoryMarker(text: string): ConversationPayload | null {
  const normalized = normalizeLocalCommandText(text);
  if (!normalized) return null;
  if (text.includes("<local-command-stdout>") && /\bCompacted\b/i.test(normalized)) {
    return { role: "system", text: COMPACT_HISTORY_MARKER };
  }
  return null;
}

function extractConversationString(text: string): ConversationPayload | null {
  if (isClaudeContinuationSummary(text)) return null;
  if (isCommandEnvelope(text)) {
    const command = extractSlashCommand(text);
    return command ? { text: command } : null;
  }
  if (isLocalCommandEnvelope(text)) return extractLocalCommandHistoryMarker(text);
  const normalized = normalizeConversationText(text);
  return normalized ? { text: normalized } : null;
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

// 从 JSONL 文件头部提取 cwd 和第一条有效用户文本消息作为标题
// cwd 从任意行的 cwd 字段获取，title 从第一条 user 消息获取
async function extractTitleAndCwd(
  filePath: string,
): Promise<{ title: string | null; cwd: string | null }> {
  return new Promise((resolve) => {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });
    let resolved = false;
    let cwd: string | null = null;
    let title: string | null = null;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      rl.close();
      input.destroy();
      resolve({ title, cwd });
    };

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
          finish();
        }
      } catch {
        /* skip malformed lines */
      }
    });

    rl.on("close", finish);
    rl.on("error", finish);
    input.on("error", finish);
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
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });
    let resolved = false;
    let id: string | null = null;
    let cwd: string | null = null;
    let title: string | null = null;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      rl.close();
      input.destroy();
      resolve({ id, title, cwd });
    };

    rl.on("line", (line) => {
      if (resolved) return;
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
        if (id && cwd && title) finish();
      } catch {
        /* skip malformed lines */
      }
    });

    rl.on("close", finish);
    rl.on("error", finish);
    input.on("error", finish);
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
    .filter(Boolean)
    .filter((text) => !isCodexInjectedContextBlock(text));
  const joined = texts.join("\n").trim();
  return normalizeHistoryTitle(joined);
}

// 判断某个 input_text 块是否为 Codex 自动注入的上下文 (AGENTS.md 指令 / environment_context)。
// 逐块过滤而非拼接后再判断: 注入块常与真实内容混在同一条消息, 且 `# AGENTS.md...` 以 `#`
// 开头会绕过 normalizeHistoryTitle 里只认 `<` 开头的噪音过滤。
function isCodexInjectedContextBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    CODEX_AGENTS_INSTRUCTIONS_PATTERN.test(trimmed) || trimmed.startsWith("<environment_context>")
  );
}
