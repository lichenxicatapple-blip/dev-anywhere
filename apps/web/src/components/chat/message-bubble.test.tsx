import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageBubble } from "./message-bubble";
import { ImagePreviewProvider } from "./image-preview";
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
    const row = bubble.querySelector('[data-slot="message-row"]');
    expect(row?.className).toContain("justify-end");
    expect(row?.className).toContain("dev-message-rail");
  });

  it("renders assistant role with data-role=assistant (left alignment)", () => {
    render(<MessageBubble message={makeMessage({ id: "a1", role: "assistant", text: "hi" })} />);
    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("assistant");
    const row = bubble.querySelector('[data-slot="message-row"]');
    expect(row?.className).toContain("justify-start");
    expect(row?.className).toContain("dev-message-rail");
    expect(row?.firstElementChild?.className).toContain("w-fit");
    expect(row?.firstElementChild?.className).toContain("max-w-[88%]");
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
    screen.getByLabelText("streaming");
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

  it("applies JSON content font size to the bubble body", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ id: "a3", role: "assistant", text: "sized" })}
        contentFontSize={18}
      />,
    );

    const body = container.querySelector<HTMLElement>('[data-slot="message-row"] > div');
    expect(body?.style.fontSize).toBe("18px");
  });

  it("renders image preview links for local image paths", () => {
    render(
      <ImagePreviewProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a4",
            role: "assistant",
            text: "screenshot: @.dev-anywhere/clipboard/s1/shot.png",
          })}
        />
      </ImagePreviewProvider>,
    );

    screen.getByRole("button", { name: /shot\.png/ });
  });
});
