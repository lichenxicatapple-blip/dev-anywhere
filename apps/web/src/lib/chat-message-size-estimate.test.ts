import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import { estimateChatMessageHeight } from "./chat-message-size-estimate";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "ok",
    isPartial: false,
    timestamp: 1,
    toolCalls: [],
    ...overrides,
  };
}

describe("estimateChatMessageHeight", () => {
  it("keeps short mobile messages close to their measured one-line height", () => {
    const estimate = estimateChatMessageHeight(makeMessage({ text: "收到 1" }), {
      fontSize: 16,
      touchEditingSurface: true,
    });

    expect(estimate).toBeGreaterThanOrEqual(56);
    expect(estimate).toBeLessThan(72);
  });

  it("estimates long mobile prose higher than short prose", () => {
    const short = estimateChatMessageHeight(makeMessage({ text: "收到" }), {
      fontSize: 16,
      touchEditingSurface: true,
    });
    const long = estimateChatMessageHeight(
      makeMessage({
        text: "这是一条较长的移动端消息，用来模拟窄屏换行后形成多行气泡的高度估算。",
      }),
      { fontSize: 16, touchEditingSurface: true },
    );

    expect(long).toBeGreaterThan(short);
  });

  it("estimates the same long text lower on desktop because fewer wraps are needed", () => {
    const message = makeMessage({
      text: "A long assistant response with enough words to wrap on a phone but stay compact on a wider desktop rail.",
    });

    const mobile = estimateChatMessageHeight(message, {
      fontSize: 16,
      touchEditingSurface: true,
    });
    const desktop = estimateChatMessageHeight(message, {
      fontSize: 16,
      touchEditingSurface: false,
    });

    expect(mobile).toBeGreaterThan(desktop);
  });
});
