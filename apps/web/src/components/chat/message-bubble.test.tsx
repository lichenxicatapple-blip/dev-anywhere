import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageBubble } from "./message-bubble";
import { ImagePreviewProvider } from "./image-preview";
import { FileDownloadProvider } from "./file-download-link";
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
    expect(bubble.className).toContain("dev-chat-rail-inset");
    const row = bubble.querySelector('[data-slot="message-row"]');
    expect(row?.className).toContain("justify-end");
    expect(row?.className).toContain("dev-message-rail");
  });

  it("renders assistant role with data-role=assistant (left alignment)", () => {
    render(<MessageBubble message={makeMessage({ id: "a1", role: "assistant", text: "hi" })} />);
    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("assistant");
    expect(bubble.className).toContain("dev-chat-rail-inset");
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

  it("keeps the streaming cursor inline with the final markdown paragraph", () => {
    render(
      <MessageBubble
        message={makeMessage({
          id: "a-inline-cursor",
          role: "assistant",
          text: "好,2-3 个项目 + 公共 proxy 已配置,那抽离是合理的。",
          isPartial: true,
        })}
      />,
    );

    const cursor = screen.getByLabelText("streaming");
    expect(cursor.parentElement?.tagName.toLowerCase()).toBe("p");
    expect(cursor.previousSibling?.textContent).toContain("合理的");
  });

  it("marks user partial messages with streaming cursor and unconfirmed style", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "u2",
          role: "user",
          text: "正在识别中",
          isPartial: true,
        })}
      />,
    );
    expect(screen.getByLabelText("streaming")).not.toBeNull();
    const bubble = container.querySelector('[data-slot="message-bubble"]');
    expect(bubble?.getAttribute("data-partial")).toBe("true");
    const body = container.querySelector<HTMLElement>('[data-slot="message-row"] > div');
    expect(body?.className).toContain("border-dashed");
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

  it("renders file paths inline and does not duplicate them as bottom download chips", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-file-link",
            role: "assistant",
            text: "See README.md for details.",
          })}
        />
      </FileDownloadProvider>,
    );

    const paragraph = container.querySelector("p");
    const inlineLink = paragraph?.querySelector('[data-slot="inline-file-download-link"]');
    expect(inlineLink?.textContent).toBe("README.md");
    expect(container.querySelector('[data-slot="file-download-links"]')).toBeNull();
  });

  it("renders inline-code file paths inside tables as download actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-table-file-link",
            role: "assistant",
            text:
              "| 文件 | 用到的符号 |\n" +
              "| - | - |\n" +
              "| `data/pipeline/sticker/sticker_classify.py` | LLMClient |",
          })}
        />
      </FileDownloadProvider>,
    );

    const firstCell = container.querySelector("td");
    const inlineLink = firstCell?.querySelector('[data-slot="inline-file-download-link"]');
    expect(inlineLink?.textContent).toContain("data/pipeline/sticker/sticker_classify.py");
  });

  it("renders image paths inline and does not duplicate them as bottom preview chips", () => {
    const { container } = render(
      <ImagePreviewProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-image-link",
            role: "assistant",
            text: "Screenshot: .dev-anywhere/clipboard/s1/shot.png",
          })}
        />
      </ImagePreviewProvider>,
    );

    const paragraph = container.querySelector("p");
    const inlineLink = paragraph?.querySelector('[data-slot="inline-image-preview-link"]');
    expect(inlineLink?.textContent).toBe(".dev-anywhere/clipboard/s1/shot.png");
    expect(container.querySelector('[data-slot="image-preview-links"]')).toBeNull();
  });

  it("does not rewrite existing markdown links or inline code into file actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-no-rewrite",
            role: "assistant",
            text: "Keep [README.md](https://example.com/readme) and `package.json` as-is.",
          })}
        />
      </FileDownloadProvider>,
    );

    expect(container.querySelector('[data-slot="inline-file-download-link"]')).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/readme");
    expect(container.querySelector("code")?.textContent).toBe("package.json");
  });

  it("does not render bare domains as file download actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-bare-domain",
            role: "assistant",
            text: "If it persists, check status.claude.com.",
          })}
        />
      </FileDownloadProvider>,
    );

    expect(container.querySelector('[data-slot="inline-file-download-link"]')).toBeNull();
    expect(container.textContent).toContain("status.claude.com");
  });

  it("renders bare domains as external links instead of download actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-bare-domain-link",
            role: "assistant",
            text: "If it persists, check status.claude.com.",
          })}
        />
      </FileDownloadProvider>,
    );

    expect(container.querySelector('[data-slot="inline-file-download-link"]')).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('[data-slot="inline-web-link"]');
    expect(link?.textContent).toBe("status.claude.com");
    expect(link?.getAttribute("href")).toBe("https://status.claude.com");
    expect(link?.querySelector(".lucide-external-link")).not.toBeNull();
  });

  it("does not render dotted API symbols as file download actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-dotted-symbol",
            role: "assistant",
            text: "schema + json.loads",
          })}
        />
      </FileDownloadProvider>,
    );

    expect(container.querySelector('[data-slot="inline-file-download-link"]')).toBeNull();
    expect(container.textContent).toContain("json.loads");
  });
});
