import { memo } from "react";
import type { ChatMessage } from "@/stores/chat-store";
import { MarkdownView } from "./markdown-view";

interface MessageBubbleProps {
  message: ChatMessage;
  contentFontSize?: number;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  contentFontSize,
}: MessageBubbleProps) {
  const role = message.role;
  const contentStyle = contentFontSize ? { fontSize: contentFontSize } : undefined;

  if (role === "user") {
    return (
      <article data-slot="message-bubble" data-role="user" className="dev-chat-rail-inset py-2">
        <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full justify-end">
          <div
            className="min-w-0 max-w-[80%] rounded-md bg-primary text-primary-foreground px-4 py-2"
            style={contentStyle}
          >
            <MarkdownView text={message.text} tone="on-primary" />
          </div>
        </div>
      </article>
    );
  }

  const streamingCursor = message.isPartial ? (
    <span
      className="inline-block w-2 h-4 ml-1 bg-[var(--color-status-working)] dev-cursor-blink align-middle"
      aria-label="streaming"
    />
  ) : null;

  return (
    <article data-slot="message-bubble" data-role={role} className="dev-chat-rail-inset py-2">
      <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full justify-start">
        <div
          className="w-fit max-w-[88%] min-w-0 rounded-md bg-card text-foreground px-4 py-2"
          style={contentStyle}
        >
          <MarkdownView text={message.text} trailingInline={streamingCursor} />
        </div>
      </div>
    </article>
  );
});
