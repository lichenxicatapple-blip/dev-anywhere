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
  | { type: "deny_once" };

export type VoiceRouteResult =
  | { kind: "command"; command: VoiceCommand }
  | { kind: "agentText"; text: string };

export interface VoiceRouteContext {
  phase: VoicePilotPhase | "drafting" | "disabled" | "starting" | "submitting" | "waitingForAgent";
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
  ["批准这次", { type: "approve_once" }],
  ["拒绝这次", { type: "deny_once" }],
]);

function normalizeCommandText(text: string): string {
  return text.trim().replace(/[。！？!?，,\s]+$/u, "");
}

export function routeVoiceText(text: string, context: VoiceRouteContext): VoiceRouteResult {
  const raw = text.trim();
  const normalized = normalizeCommandText(raw);
  const approvalCommand = APPROVAL_COMMANDS.get(normalized);
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
