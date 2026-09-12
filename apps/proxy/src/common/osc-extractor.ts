import type { PtySemanticState } from "@dev-anywhere/shared";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

// OSC 0: 窗口标题 -- ESC ] 0 ; <title> BEL/ST
// OSC 9: 通知 -- ESC ] 9 ; <text> BEL/ST
// 每次调用创建新的 regex 实例避免 g flag 导致的 lastIndex 状态泄漏
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\](\d+);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

type PtySignalProvider = "claude" | "codex" | "kimi";

interface PtyStateEvent {
  state: PtySemanticState | null;
  title?: string;
  tool?: string;
}

interface OscSequence {
  code: number;
  text: string;
}

// Keep enough recent text to bridge PTY chunk splits without retaining whole scrollback.
const SEMANTIC_TEXT_TAIL_MAX = 4096;

// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE_PATTERN = /\x1b\](?:\d+);[^\x07\x1b]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const SIMPLE_ESC_PATTERN = /\x1b[@-Z\\-_]/g;

export function extractOscSequences(rawData: string): OscSequence[] {
  const regex = new RegExp(OSC_PATTERN.source, OSC_PATTERN.flags);
  const matches: OscSequence[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawData)) !== null) {
    matches.push({ code: parseInt(match[1], 10), text: match[2] });
  }

  return matches;
}

function lastSequence(matches: OscSequence[], code: number): OscSequence | undefined {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].code === code) return matches[i];
  }
  return undefined;
}

export function extractOscWorkingDirectory(
  rawData: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const sequences = extractOscSequences(rawData);
  for (let index = sequences.length - 1; index >= 0; index--) {
    const sequence = sequences[index];
    if (sequence.code === 9 && sequence.text.startsWith("9;")) {
      const path = sequence.text.slice(2).replace(/^"(.*)"$/, "$1");
      if (/[\0\r\n]/.test(path)) return null;
      return (platform === "win32" ? win32 : posix).isAbsolute(path) ? path : null;
    }
    if (sequence.code !== 7) continue;
    try {
      const uri = new URL(sequence.text);
      if (uri.protocol !== "file:") return null;
      // POSIX shells include their host in OSC 7. A Windows drive URL may also
      // include it; retain an authority only when it identifies a UNC share.
      if (platform !== "win32" || /^\/[a-z]:\//i.test(uri.pathname)) uri.hostname = "";
      const path = fileURLToPath(uri, { windows: platform === "win32" });
      return /[\0\r\n]/.test(path) ? null : path;
    } catch {
      return null;
    }
  }
  return null;
}

export class OscWorkingDirectoryTracker {
  private pending = "";

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  push(data: string): string | null {
    const combined = this.pending + data;
    const cwd = extractOscWorkingDirectory(combined, this.platform);
    const start = combined.lastIndexOf("\x1b]");
    const tail = start < 0 ? "" : combined.slice(start);
    // A shell's directory report can be split anywhere, including ESC ] or ST.
    // Bound malformed/unterminated output without keeping terminal history.
    this.pending =
      tail && !tail.includes("\x07") && !tail.includes("\x1b\\") && tail.length <= 64 * 1024
        ? tail
        : combined.endsWith("\x1b")
          ? "\x1b"
          : "";
    return cwd;
  }
}

export function normalizePtySemanticText(rawData: string): string {
  return rawData
    .replace(OSC_SEQUENCE_PATTERN, " ")
    .replace(CSI_SEQUENCE_PATTERN, " ")
    .replace(SIMPLE_ESC_PATTERN, " ")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

export function appendPtySemanticTextTail(previous: string, chunk: string): string {
  const next = `${previous}\n${normalizePtySemanticText(chunk)}`.slice(-SEMANTIC_TEXT_TAIL_MAX);
  return next.trim();
}

function extractClaudeTextSignal(text: string): PtyStateEvent | null {
  const toolMatch = text.match(/\bHook\s+PreToolUse:([A-Za-z0-9_.:-]+)/i);
  if (
    toolMatch?.[1] &&
    /\brequires confirmation for this (?:command|tool)\b/i.test(text) &&
    /\bDo you want to proceed\?/i.test(text)
  ) {
    return {
      state: "approval_wait",
      tool: toolMatch[1],
      title: `Hook confirmation: ${toolMatch[1]}`,
    };
  }

  const nativePermissionMatch = text.match(
    /\bDo you want to (?<action>make this edit to|create|update|delete|run|execute)\b[^\n?]*\?/i,
  );
  if (
    nativePermissionMatch?.groups?.action &&
    /\b1\.\s*Yes\b/i.test(text) &&
    /\b3\.\s*No\b/i.test(text)
  ) {
    const action = nativePermissionMatch.groups.action.toLowerCase();
    const tool = action === "run" || action === "execute" ? "Bash" : "Edit";
    return {
      state: "approval_wait",
      tool,
      title: `Claude permission: ${tool}`,
    };
  }
  return null;
}

export function extractTextSignals(
  semanticText: string,
  provider?: PtySignalProvider,
): PtyStateEvent | null {
  if (provider === "claude") {
    return extractClaudeTextSignal(semanticText);
  }
  return null;
}

// 从 PTY 原始数据中提取 OSC 语义信号。
// OSC 9 优先级高于 OSC 0，无匹配时返回 null。
// 仅 OSC 0（spinner/标题）返回 { state: null, title }，让调用方推 title 但不动 FSM。
export function extractOscSignals(
  rawData: string,
  _provider?: PtySignalProvider,
): PtyStateEvent | null {
  const matches = extractOscSequences(rawData);

  if (matches.length === 0) return null;

  const osc0 = lastSequence(matches, 0);

  // OSC 9 优先级更高，包含具体的语义信号；同帧 OSC 0 仍保留 title 给 UI。
  const osc9 = lastSequence(matches, 9);
  if (osc9) {
    if (osc9.text.includes("waiting for your input") || osc9.text.trim() === "4;0;") {
      return { state: "turn_complete", ...(osc0 ? { title: osc0.text } : {}) };
    }
    if (osc9.text.includes("needs your permission")) {
      const toolMatch = osc9.text.match(/permission.*?:\s*(\S+)/);
      return {
        state: "approval_wait",
        ...(osc0 ? { title: osc0.text } : {}),
        ...(toolMatch?.[1] ? { tool: toolMatch[1] } : {}),
      };
    }
  }

  // Codex also uses "Action Required" for unanswered questions. A window title
  // alone cannot identify an approval request; keep it as display metadata.
  // 仅 OSC 0：标题/spinner 更新，没有明确语义信号。state=null 让上层只推 title。
  if (osc0 && !osc9) {
    return { state: null, title: osc0.text };
  }

  return null;
}
