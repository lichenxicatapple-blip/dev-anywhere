import type { VoicePilotPhase } from "./voice-pilot-store";

export type VoiceCommand =
  | { type: "repeat" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "redo" }
  | { type: "status" }
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
  ["暂停", { type: "pause" }],
  ["取消", { type: "cancel" }],
  ["重说", { type: "redo" }],
  ["状态", { type: "status" }],
  ["退出语音助手", { type: "exit" }],
  ["关闭语音助手", { type: "exit" }],
  ["停止语音模式", { type: "exit" }],
]);

const APPROVAL_COMMANDS = new Map<string, VoiceCommand>([
  ["允许", { type: "approve_once" }],
  ["始终允许", { type: "approve_always" }],
  ["拒绝", { type: "deny_once" }],
]);

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

export function routeVoiceText(text: string, context: VoiceRouteContext): VoiceRouteResult {
  const raw = text.trim();
  const normalized = normalizeCommandText(raw);
  const approvalCommand =
    context.approvalPromptActive === true
      ? APPROVAL_COMMANDS.get(approvalCommandText(raw))
      : undefined;
  if (approvalCommand) {
    return { kind: "command", command: approvalCommand };
  }
  const exactCommand = EXACT_COMMANDS.get(normalized);
  if (exactCommand) return { kind: "command", command: exactCommand };
  if (normalized === "继续" && context.phase === "paused") {
    return { kind: "command", command: { type: "resume" } };
  }
  return { kind: "agentText", text: raw };
}
