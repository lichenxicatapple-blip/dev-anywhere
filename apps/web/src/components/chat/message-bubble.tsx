import { memo } from "react";
import type { ChatMessage } from "@/stores/chat-store";
import { MarkdownView } from "./markdown-view";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const role = message.role;

  if (role === "user") {
    return (
      <article data-slot="message-bubble" data-role="user" className="flex justify-end px-4 py-2">
        <div className="max-w-[80%] rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm">
          <MarkdownView text={message.text} tone="on-primary" />
        </div>
      </article>
    );
  }

  return (
    <article
      data-slot="message-bubble"
      data-role={role}
      className={cn("flex justify-start px-4 py-2")}
    >
      <div className="max-w-[80%] rounded-md bg-card text-foreground px-4 py-2 text-sm">
        <MarkdownView text={message.text} />
        {message.isPartial && (
          <span
            className="inline-block w-2 h-4 ml-1 bg-[var(--color-status-working)] cc-cursor-blink align-middle"
            aria-label="streaming"
          />
        )}
      </div>
    </article>
  );
});
