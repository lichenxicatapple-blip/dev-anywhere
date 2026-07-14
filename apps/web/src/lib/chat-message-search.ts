import type { ChatMessage } from "@/stores/chat-store";

export function findChatMessageIndexes(messages: ChatMessage[], query: string): number[] {
  if (!query) return [];
  const normalizedQuery = query.toLowerCase();
  const matches: number[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].text.toLowerCase().includes(normalizedQuery)) {
      matches.push(index);
    }
  }

  return matches;
}
