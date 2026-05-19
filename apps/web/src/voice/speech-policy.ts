import type { VoiceSummaryReason } from "@dev-anywhere/shared";

export type SpeechPolicy =
  | { mode: "direct" }
  | { mode: "summary_required"; reason: VoiceSummaryReason };

interface SpeechPolicyOptions {
  maxDirectChars?: number;
}

const DEFAULT_MAX_DIRECT_CHARS = 900;

function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line, index) => {
    const next = lines[index + 1];
    return (
      line.includes("|") &&
      typeof next === "string" &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
    );
  });
}

function hasDiff(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line) => /^\+[^+]/.test(line)) && lines.some((line) => /^-[^-]/.test(line));
}

function hasStackTrace(text: string): boolean {
  return /\n\s+at\s+.+:\d+:\d+/.test(text) || /Traceback \(most recent call last\):/.test(text);
}

function hasLogLikeContent(text: string): boolean {
  return /\b(ERROR|WARN|INFO|DEBUG)\b[:\s]/.test(text) || /\[\d{2}:\d{2}:\d{2}]/.test(text);
}

function hasLongList(text: string): boolean {
  return text.split("\n").filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length >= 8;
}

export function decideSpeechPolicy(text: string, options: SpeechPolicyOptions = {}): SpeechPolicy {
  const trimmed = text.trim();
  if (/```/.test(trimmed)) return { mode: "summary_required", reason: "code" };
  if (hasMarkdownTable(trimmed)) return { mode: "summary_required", reason: "table" };
  if (hasStackTrace(trimmed)) return { mode: "summary_required", reason: "stack_trace" };
  if (hasDiff(trimmed)) return { mode: "summary_required", reason: "diff" };
  if (hasLogLikeContent(trimmed)) return { mode: "summary_required", reason: "log" };
  if (hasLongList(trimmed)) return { mode: "summary_required", reason: "long_list" };
  if (trimmed.length > (options.maxDirectChars ?? DEFAULT_MAX_DIRECT_CHARS)) {
    return { mode: "summary_required", reason: "long_text" };
  }
  return { mode: "direct" };
}
