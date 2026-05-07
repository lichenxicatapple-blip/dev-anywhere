import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "@/stores/chat-store";

// vitest 不自动 cleanup, 手工 afterEach 否则相邻 render 的 DOM 会累积
afterEach(cleanup);

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m-1",
    role: "user",
    text: "hello",
    isPartial: false,
    timestamp: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe("MessageBubble", () => {
  it("renders user role with data-role=user (right alignment)", () => {
    render(<MessageBubble message={makeMessage({ id: "u1", role: "user", text: "hello" })} />);
    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("user");
    expect(bubble.className).toContain("justify-end");
  });

  it("renders assistant role with data-role=assistant (left alignment)", () => {
    render(<MessageBubble message={makeMessage({ id: "a1", role: "assistant", text: "hi" })} />);
    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("assistant");
    expect(bubble.className).toContain("justify-start");
  });

  it("shows streaming cursor when assistant isPartial=true", () => {
    render(
      <MessageBubble
        message={makeMessage({
          id: "a2",
          role: "assistant",
          text: "partial",
          isPartial: true,
        })}
      />,
    );
    expect(screen.getByLabelText("streaming")).toBeDefined();
  });

  it("does not render cursor for user messages even if isPartial true", () => {
    render(
      <MessageBubble
        message={makeMessage({
          id: "u2",
          role: "user",
          text: "x",
          isPartial: true,
        })}
      />,
    );
    expect(screen.queryByLabelText("streaming")).toBeNull();
  });
});
