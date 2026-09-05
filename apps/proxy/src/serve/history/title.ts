const MAX_HISTORY_TITLE_LENGTH = 40;
const IGNORED_SLASH_COMMANDS = new Set([
  "/clear",
  "/model",
  "/compact",
  "/help",
  "/config",
  "/logout",
]);
const INTERNAL_TITLE_PATTERNS = [
  /^the following is the codex agent history\b/i,
  /^codex agent history\b/i,
  /^conversation summary\b/i,
];
const CLAUDE_CONTINUATION_SUMMARY_PATTERN =
  /^This session is being continued from a previous conversation that ran out of context\.\s+The summary below covers the earlier portion of the conversation\.\s+Summary:/i;

export function isClaudeContinuationSummary(text: string): boolean {
  return CLAUDE_CONTINUATION_SUMMARY_PATTERN.test(text.trimStart());
}

export function isCodexInjectedContextBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^#\s*AGENTS\.md instructions for\b/i.test(trimmed) ||
    trimmed.startsWith("<environment_context>")
  );
}

/** Content evidence is independent of whether text makes a useful display title. */
export function isConversationText(raw: string): boolean {
  const text = raw.trim();
  if (!text || isCodexInjectedContextBlock(text) || isClaudeContinuationSummary(text)) return false;
  if (INTERNAL_TITLE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (/^<(?:environment|system|developer|assistant|user|tool|context)(?:[_\s>:-])/i.test(text)) {
    return false;
  }
  const slashCommand = text.match(/^\/\S+/)?.[0];
  return !slashCommand || !IGNORED_SLASH_COMMANDS.has(slashCommand);
}

export function normalizeHistoryTitle(raw: string | null | undefined): string | null {
  if (!raw || !isConversationText(raw)) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.startsWith("<")) return null;
  const chars = Array.from(text);
  return chars.length > MAX_HISTORY_TITLE_LENGTH
    ? `${chars.slice(0, MAX_HISTORY_TITLE_LENGTH).join("")}...`
    : text;
}
