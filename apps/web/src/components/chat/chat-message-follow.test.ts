import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import { isLiveVoiceTranscript } from "./chat-message-follow";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "user",
    text: "正在识别",
    isPartial: true,
    timestamp: 1,
    toolCalls: [],
    ...overrides,
  };
}

describe("isLiveVoiceTranscript", () => {
  it("identifies only in-progress voice input", () => {
    expect(isLiveVoiceTranscript(message({ inputMethod: "voice" }))).toBe(true);
    expect(isLiveVoiceTranscript(message({ inputMethod: "voice", isPartial: false }))).toBe(false);
    expect(isLiveVoiceTranscript(message())).toBe(false);
    expect(
      isLiveVoiceTranscript(message({ role: "assistant", inputMethod: "voice" })),
    ).toBe(false);
  });
});
