import { readdir, lstat, access, open, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { summarizeToolActivity, type SessionHistoryMessage } from "@dev-anywhere/shared";
import { collectJsonlFiles, collectFilesNamed } from "./history/files.js";
import { claudeProjectsDir, codexSessionsDir, kimiSessionsDir } from "./history/paths.js";
import { readCodexSessionId } from "./history/codex.js";
import { normalizeHistoryTitle, isClaudeContinuationSummary } from "./history/title.js";
import { SAFE_SESSION_ID_PATTERN } from "./history/types.js";

async function readKimiSessionState(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
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

type SessionHistoryProvider = "claude" | "codex" | "kimi";

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
      const id = await readCodexSessionId(filePath);
      if (id === codexSessionId) return filePath;
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
  if (provider === "kimi") return findKimiSessionFile(sessionId);
  return (await findClaudeSessionFile(sessionId)) ?? (await findCodexSessionFile(sessionId));
}

async function findKimiSessionFile(kimiSessionId: string): Promise<string | null> {
  if (!SAFE_SESSION_ID_PATTERN.test(kimiSessionId)) return null;
  const stateFiles = await collectFilesNamed(kimiSessionsDir(), "state.json");
  for (const stateFile of stateFiles) {
    const state = await readKimiSessionState(stateFile);
    if (state?.id !== kimiSessionId) continue;
    const wireFile = join(stateFile.slice(0, -"state.json".length), "agents", "main", "wire.jsonl");
    try {
      const wireStat = await lstat(wireFile);
      if (wireStat.isSymbolicLink() || !wireStat.isFile()) continue;
      return wireFile;
    } catch {
      continue;
    }
  }
  return null;
}

function historyTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
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
  const kimiTimestamp = historyTimestamp((record as { time?: unknown }).time);
  if (record.type === "turn.prompt") {
    // `turn.prompt` is Kimi's durable user-turn record in both terminal and ACP sessions.
    // ACP also writes an adjacent `prompt.accepted` copy, so treating that transport-level
    // record as history would duplicate every ACP prompt while omitting terminal prompts.
    const input = (record as { input?: unknown }).input;
    return extractClaudeContentItems("user", input, kimiTimestamp);
  }
  if (record.type === "context.append_loop_event") {
    const event = asRecord((record as { event?: unknown }).event);
    if (!event || typeof event.type !== "string") return [];
    if (event.type === "content.part") {
      const part = asRecord(event.part);
      if (part?.type !== "text" || typeof part.text !== "string") return [];
      const text = normalizeConversationText(part.text);
      return text
        ? [
            {
              kind: "message",
              message: {
                role: "assistant",
                text,
                ...(kimiTimestamp !== undefined ? { timestamp: kimiTimestamp } : {}),
              },
            },
          ]
        : [];
    }
    if (
      event.type === "tool.call" &&
      typeof event.toolCallId === "string" &&
      typeof event.name === "string"
    ) {
      const item = toolUseHistoryItem(event.toolCallId, event.name, event.args, kimiTimestamp);
      return item ? [item] : [];
    }
    if (event.type === "tool.result" && typeof event.toolCallId === "string") {
      const result = asRecord(event.result);
      return [
        {
          kind: "tool-result",
          toolId: event.toolCallId,
          isError: Boolean(result?.error) || result?.isError === true,
        },
      ];
    }
    return [];
  }
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

function normalizeConversationText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed;
}
