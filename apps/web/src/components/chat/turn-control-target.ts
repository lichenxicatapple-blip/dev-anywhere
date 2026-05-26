import type { ChatMessage } from "@/stores/chat-store";

export interface TurnControlTarget {
  messageId: string | null;
  showThinking: boolean;
}

function isRunningActivity(message: ChatMessage): boolean {
  if (message.role !== "activity") return false;
  const status = message.activity?.status ?? (message.isPartial ? "running" : "done");
  return status === "running";
}

export function getTurnControlTarget({
  messages,
  isWorking,
  hasPendingApprovals,
}: {
  messages: ChatMessage[];
  isWorking: boolean;
  hasPendingApprovals: boolean;
}): TurnControlTarget {
  if (!isWorking || hasPendingApprovals) {
    return { messageId: null, showThinking: false };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRunningActivity(message)) {
      return { messageId: message.id, showThinking: false };
    }
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant" && lastMessage.isPartial) {
    return { messageId: lastMessage.id, showThinking: false };
  }

  return { messageId: null, showThinking: true };
}
