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
  approval: "tool approval request",
};

interface BuildVoiceSummaryPromptOptions {
  reason: VoiceSummaryReason;
  text: string;
}

export function buildVoiceSummaryPrompt({ reason, text }: BuildVoiceSummaryPromptOptions): string {
  const clippedText = text.length > 24_000 ? `${text.slice(0, 24_000)}\n\n[truncated]` : text;
  if (reason === "approval") {
    return [
      "You are producing speech for a hands-free developer assistant.",
      "",
      "The user must decide whether to approve one pending developer tool request.",
      "Create a concise but useful Chinese spoken approval summary.",
      "",
      "Rules:",
      "- Output one or two Chinese sentences.",
      "- Keep it under 100 Chinese characters; aim for 60-85.",
      "- Say what the tool wants to do in plain language and include enough context to decide.",
      "- Use the parameters to infer the key target, such as the exact search topic, short file name, command purpose, or result count.",
      "- Prefer concrete names from the request over generic nouns.",
      "- If a file/path/query/tool target is present, name it with a short basename, short path, or query topic.",
      "- Do not say generic phrases like 项目配置文件, 某个文件, 相关资料, or 网络搜索 when a concrete target is available.",
      "- For search requests, include the query topic and result count when present.",
      "- For file requests, include the concrete file name or short path when present.",
      "- Mention up to two key parameters when they materially clarify the action.",
      "- Do not evaluate risk or safety; the user will decide from the approval card.",
      "- Do not read raw JSON, raw shell commands, IDs, or full paths.",
      "- Do not add greetings, markdown, explanations, or approval instructions.",
      "",
      "Good examples:",
      "- 要搜索 Web Speech 的官方资料，最多返回十条结果。",
      "- 要读取 package.json，用来确认构建脚本和依赖配置。",
      "- 要读取 apps/web/package.json，用来确认 Web 应用的脚本和依赖。",
      "- 要编辑 src/app.ts，把入口逻辑改成新的初始化流程。",
      "- 要删除构建目录 dist，清理旧的产物后重新生成。",
      "",
      "Tool request:",
      clippedText,
    ].join("\n");
  }
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
