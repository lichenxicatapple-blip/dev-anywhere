import type { VoicePilotPhase } from "./voice-pilot-store";

export type VoiceCommand =
  | { type: "repeat" }
  | { type: "exit" }
  | { type: "approve_once" }
  | { type: "approve_always" }
  | { type: "deny_once" };

type VoiceRouteResult =
  | { kind: "command"; command: VoiceCommand }
  | { kind: "agentText"; text: string };

interface VoiceRouteContext {
  phase: VoicePilotPhase | "disabled" | "waitingForAgent";
  approvalPromptActive?: boolean;
}

const EXACT_COMMANDS = new Map<string, VoiceCommand>([
  ["复述", { type: "repeat" }],
  ["再说一遍", { type: "repeat" }],
]);

const EXIT_COMMAND_PHRASES = ["退出语音助手", "关闭语音助手", "停止语音助手"] as const;
const VOICE_PILOT_EXIT_COMMAND_PATTERN = /(?:退出|关闭|停止)\s*voice\s*pilot/iu;

const APPROVAL_COMMAND_RULES: ReadonlyArray<{
  phrases: readonly string[];
  command: VoiceCommand;
}> = [
  {
    phrases: ["不同意", "不允许", "不要同意", "不要允许", "别同意", "别允许", "拒绝"],
    command: { type: "deny_once" },
  },
  {
    phrases: ["始终允许"],
    command: { type: "approve_always" },
  },
  {
    phrases: ["同意", "允许"],
    command: { type: "approve_once" },
  },
];

function normalizeCommandText(text: string): string {
  return text.trim().replace(/[。！？!?，,\s]+$/u, "");
}

function approvalCommandText(text: string): string {
  const normalized = normalizeCommandText(text);
  const parts = normalized
    .split(/[。！？!?，,；;\s]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function matchApprovalCommand(text: string): VoiceCommand | undefined {
  const clause = approvalCommandText(text);
  return APPROVAL_COMMAND_RULES.find(({ phrases }) =>
    phrases.some((phrase) => clause.includes(phrase)),
  )?.command;
}

export function routeVoiceText(text: string, context: VoiceRouteContext): VoiceRouteResult {
  const raw = text.trim();
  const normalized = normalizeCommandText(raw);
  const approvalCommand =
    context.approvalPromptActive === true ? matchApprovalCommand(raw) : undefined;
  if (approvalCommand) {
    return { kind: "command", command: approvalCommand };
  }
  if (
    EXIT_COMMAND_PHRASES.some((phrase) => normalized.includes(phrase)) ||
    VOICE_PILOT_EXIT_COMMAND_PATTERN.test(normalized)
  ) {
    return { kind: "command", command: { type: "exit" } };
  }
  const exactCommand = EXACT_COMMANDS.get(normalized);
  if (exactCommand) return { kind: "command", command: exactCommand };
  return { kind: "agentText", text: raw };
}
