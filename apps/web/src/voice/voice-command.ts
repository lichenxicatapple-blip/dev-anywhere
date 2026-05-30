import { routeVoiceText, type VoiceCommand } from "./voice-command-router";

export function parseVoiceCommand(text: string): VoiceCommand | null {
  const result = routeVoiceText(text, { phase: "listening", approvalPromptActive: true });
  return result.kind === "command" ? result.command : null;
}
