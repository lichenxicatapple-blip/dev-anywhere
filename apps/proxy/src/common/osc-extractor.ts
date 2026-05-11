import type { PtySemanticState } from "@dev-anywhere/shared";

// OSC 0: 窗口标题 -- ESC ] 0 ; <title> BEL/ST
// OSC 9: 通知 -- ESC ] 9 ; <text> BEL/ST
// 每次调用创建新的 regex 实例避免 g flag 导致的 lastIndex 状态泄漏
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\](\d+);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

type PtySignalProvider = "claude" | "codex";

interface PtyStateEvent {
  state: PtySemanticState | null;
  title?: string;
  tool?: string;
}

interface OscSequence {
  code: number;
  text: string;
}

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

function isCodexActionRequiredTitle(title: string): boolean {
  return /\bAction Required\b/i.test(title);
}

// 从 PTY 原始数据中提取 OSC 语义信号。
// OSC 9 优先级高于 OSC 0，无匹配时返回 null。
// 仅 OSC 0（spinner/标题）返回 { state: null, title }，让调用方推 title 但不动 FSM。
export function extractOscSignals(
  rawData: string,
  provider?: PtySignalProvider,
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

  if (provider === "codex" && osc0 && isCodexActionRequiredTitle(osc0.text)) {
    return { state: "approval_wait", title: osc0.text };
  }

  // 仅 OSC 0：标题/spinner 更新，没有明确语义信号。state=null 让上层只推 title。
  if (osc0 && !osc9) {
    return { state: null, title: osc0.text };
  }

  return null;
}
