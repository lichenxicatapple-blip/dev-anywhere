import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import { findChatMessageIndexes } from "./chat-message-search";

function message(id: string, text: string): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    isPartial: false,
    timestamp: 0,
    toolCalls: [],
  };
}

describe("findChatMessageIndexes", () => {
  it("matches message text case-insensitively and returns one result per message", () => {
    const messages = [
      message("a", "Alpha appears twice: alpha"),
      message("b", "unrelated"),
      message("c", "ALPHA in another bubble"),
    ];

    expect(findChatMessageIndexes(messages, "alpha")).toEqual([0, 2]);
  });

  it("returns no matches for an empty query", () => {
    expect(findChatMessageIndexes([message("a", "anything")], "")).toEqual([]);
  });
});
