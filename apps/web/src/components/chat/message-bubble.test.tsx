import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("renders system history markers as centered dividers instead of chat bubbles", () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ id: "s1", role: "system", text: "上下文已压缩" })} />,
    );

    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("system");
    expect(screen.getByText("上下文已压缩")).not.toBeNull();
    const marker = container.querySelector('[data-slot="message-system-marker"]');
    expect(marker?.className).toContain("rounded-full");
    expect(marker?.className).not.toContain("bg-card");
  });

  it("does not show a streaming cursor for assistant partial text", () => {
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
    expect(screen.queryByLabelText("streaming")).toBeNull();
  });

  it("keeps assistant partial text as plain markdown without an inline cursor", () => {
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

    expect(screen.queryByLabelText("streaming")).toBeNull();
    expect(screen.getByText(/合理的/).tagName.toLowerCase()).toBe("p");
  });

  it("renders running activity bubbles in the assistant rail", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-1",
          role: "activity",
          text: "运行命令：pnpm test",
          isPartial: true,
          activity: {
            id: "tool-1",
            source: "claude-native",
            kind: "tool",
            status: "running",
            text: "运行命令：pnpm test",
            durable: false,
          },
        })}
      />,
    );

    const bubble = screen.getByRole("article");
    expect(bubble.getAttribute("data-role")).toBe("activity");
    expect(container.querySelector('[data-slot="activity-spinner"]')).not.toBeNull();
    expect(screen.getByText("运行命令：pnpm test")).not.toBeNull();
  });

  it("allows long activity command paths to wrap without early hyphen gaps", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-long-command",
          role: "activity",
          text: `运行命令： /bin/zsh -lc "sed -n '1,200p' /Users/catli/.codex/plugins/cache/openai-curated/superpowers/6188456f/skills/using-superpowers/SKILL.md"`,
          activity: {
            id: "tool-long-command",
            source: "claude-native",
            kind: "tool",
            status: "done",
            text: "运行命令",
            durable: true,
          },
        })}
      />,
    );

    const activityText = container.querySelector<HTMLElement>('[data-slot="activity-text"]');
    expect(activityText?.textContent).toContain("openai-curated");
    expect(activityText?.className).toContain("[overflow-wrap:anywhere]");
  });

  it("uses warning styling for errored activity bubbles instead of destructive red", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-error",
          role: "activity",
          text: "运行命令：pnpm test",
          activity: {
            id: "tool-error",
            source: "claude-native",
            kind: "tool",
            status: "error",
            text: "运行命令：pnpm test",
            durable: true,
          },
        })}
      />,
    );

    const activity = container.querySelector<HTMLElement>('[data-slot="activity-bubble"]');
    expect(activity?.getAttribute("data-status")).toBe("error");
    expect(activity?.className).toContain("text-[var(--color-status-warning)]");
    expect(activity?.className).not.toContain("text-destructive");
    expect(activity?.className).not.toContain("bg-destructive");
    expect(activity?.className).not.toContain("border-destructive");
  });

  it("keeps raw activity details collapsed behind a chevron", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-details",
          role: "activity",
          text: "写入文件：/tmp/result.txt",
          activity: {
            id: "tool-details",
            source: "claude-native",
            kind: "tool",
            status: "done",
            text: "写入文件：/tmp/result.txt",
            durable: true,
            details: [{ title: "写入内容", content: "line 1\nline 2" }],
          },
        })}
      />,
    );

    expect(container.querySelector('[data-slot="activity-details"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    expect(container.querySelector('[data-slot="activity-details"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-detail-content"]')?.textContent).toBe(
      "line 1\nline 2",
    );
  });

  it("renders replacement activity details as unified diff rows", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-diff",
          role: "activity",
          text: "编辑文件：/tmp/result.txt",
          activity: {
            id: "tool-diff",
            source: "claude-native",
            kind: "tool",
            status: "done",
            text: "编辑文件：/tmp/result.txt",
            durable: true,
            details: [
              {
                kind: "diff",
                title: "变更预览",
                content: "same\nold\nsame\nnew",
                oldContent: "same\nold",
                newContent: "same\nnew",
              },
            ],
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    expect(container.querySelector('[data-slot="activity-diff-content"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-detail-content"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="remove"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="add"]'),
    ).toHaveLength(1);
    expect(container.querySelector('[data-slot="activity-diff-content"]')?.textContent).toContain(
      "old",
    );
    expect(container.querySelector('[data-slot="activity-diff-content"]')?.textContent).toContain(
      "new",
    );
  });

  it("renders added file activity details as all added diff rows", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-added-file",
          role: "activity",
          text: "应用补丁：/tmp/hello_world.rs",
          activity: {
            id: "tool-added-file",
            source: "claude-native",
            kind: "tool",
            status: "done",
            text: "应用补丁：/tmp/hello_world.rs",
            durable: true,
            details: [
              {
                kind: "diff",
                title: "新增：/tmp/hello_world.rs",
                content: '@@ -0,0 +1,3 @@\n+fn main() {\n+    println!("Hello, world!");\n+}\n',
                oldContent: "",
                newContent: 'fn main() {\n    println!("Hello, world!");\n}',
              },
            ],
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    expect(container.querySelector('[data-slot="activity-detail-content"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="remove"]'),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="context"]'),
    ).toHaveLength(0);
    const addedRows = container.querySelectorAll(
      '[data-slot="activity-diff-row"][data-kind="add"]',
    );
    expect(addedRows).toHaveLength(3);
    for (const row of addedRows) {
      expect(row.className).toContain("bg-emerald");
    }
    expect(container.querySelector('[data-slot="activity-diff-content"]')?.textContent).toContain(
      'println!("Hello, world!");',
    );
  });

  it("renders turn controls inside running activity bubbles", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "act-control",
          role: "activity",
          text: "搜索：LLMClient",
          isPartial: true,
          activity: {
            id: "tool-control",
            source: "claude-native",
            kind: "tool",
            status: "running",
            text: "搜索：LLMClient",
            durable: false,
          },
        })}
        turnControl={<button type="button">停止响应</button>}
      />,
    );

    expect(container.querySelector('[data-slot="activity-turn-control"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "停止响应" })).not.toBeNull();
  });

  it("renders turn controls inside active assistant bubbles without adding another bubble", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "assistant-control",
          role: "assistant",
          text: "正在输出内容",
          isPartial: true,
        })}
        turnControl={<button type="button">停止响应</button>}
      />,
    );

    expect(container.querySelectorAll('[data-slot="message-bubble"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="assistant-turn-control"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "停止响应" })).not.toBeNull();
  });

  it("preserves user-authored line breaks in sent message bubbles", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "u-newline",
          role: "user",
          text: "第一行\n第二行",
        })}
      />,
    );

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe("第一行\n第二行");
    expect(paragraph?.className).toContain("whitespace-pre-wrap");
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

  it("marks queued user messages without treating them as streaming text", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({
          id: "u3",
          role: "user",
          text: "queued instruction",
          deliveryStatus: "queued",
        })}
      />,
    );

    expect(screen.getByText("已排队")).not.toBeNull();
    expect(screen.queryByLabelText("streaming")).toBeNull();
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

  it("renders markdown links to local file paths as download actions", () => {
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "a-local-file-markdown-link",
            role: "assistant",
            text: "Open [/Users/catli/MyApps/rust-feature-tests/hello_world.rs](/Users/catli/MyApps/rust-feature-tests/hello_world.rs)",
          })}
        />
      </FileDownloadProvider>,
    );

    const inlineLink = container.querySelector('[data-slot="inline-file-download-link"]');
    expect(inlineLink?.textContent).toContain("hello_world.rs");
    expect(
      container.querySelector('a[href="/Users/catli/MyApps/rust-feature-tests/hello_world.rs"]'),
    ).toBeNull();
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

  it("keeps scp-like git remotes visible as plain user text", () => {
    const remote = "git@github.com:lichenxicatapple-blip/llm-proxy-client.git";
    const { container } = render(
      <FileDownloadProvider sessionId="s1">
        <MessageBubble
          message={makeMessage({
            id: "u-git-remote",
            role: "user",
            text: remote,
          })}
        />
      </FileDownloadProvider>,
    );

    expect(container.querySelector('[data-slot="inline-file-download-link"]')).toBeNull();
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.textContent).toContain(remote);
  });
});
