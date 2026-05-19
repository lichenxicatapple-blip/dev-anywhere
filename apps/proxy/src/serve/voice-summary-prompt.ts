import type { VoiceSummaryReason } from "@dev-anywhere/shared";

const reasonLabels: Record<VoiceSummaryReason, string> = {
  code: "code block",
  table: "table",
  diff: "diff",
  log: "log output",
  stack_trace: "stack trace",
  long_list: "long list",
  long_text: "long reply",
  mixed: "mixed structured content",
};

interface BuildVoiceSummaryPromptOptions {
  reason: VoiceSummaryReason;
  text: string;
}

export function buildVoiceSummaryPrompt({ reason, text }: BuildVoiceSummaryPromptOptions): string {
  const clippedText = text.length > 24_000 ? `${text.slice(0, 24_000)}\n\n[truncated]` : text;
  return [
    "You are producing speech for a hands-free developer assistant.",
    "",
    `The assistant response contains ${reasonLabels[reason]} content that should not be read verbatim.`,
    "Create a concise Chinese speech summary for the user.",
    "",
    "Rules:",
    "- Do not use Markdown tables.",
    "- Do not include code blocks or raw stack traces.",
    "- Mention that the structured/code/log content was summarized.",
    "- Preserve concrete decisions, risks, commands, filenames, and next actions when they matter.",
    "- Keep it short enough to read aloud naturally, ideally 2-4 sentences.",
    "",
    "Assistant response:",
    clippedText,
  ].join("\n");
}
