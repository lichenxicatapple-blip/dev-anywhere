import type { ChatMessage } from "@/stores/chat-store";

export function isLiveVoiceTranscript(message: ChatMessage | undefined): boolean {
  return Boolean(
    message?.role === "user" && message.isPartial && message.inputMethod === "voice",
  );
}
