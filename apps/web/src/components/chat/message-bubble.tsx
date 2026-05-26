import { Clock3 } from "lucide-react";
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

  const streamingCursor = role === "user" && message.isPartial ? (
    <span
      className="inline-block w-2 h-4 ml-1 bg-[var(--color-status-working)] dev-cursor-blink align-middle"
      aria-label="streaming"
    />
  ) : null;

  if (role === "system") {
    return (
      <article data-slot="message-bubble" data-role="system" className="dev-chat-rail-inset py-2">
        <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full items-center">
          <div className="h-px flex-1 bg-border" />
          <div
            data-slot="message-system-marker"
            className="mx-3 shrink-0 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground"
          >
            {message.text}
          </div>
          <div className="h-px flex-1 bg-border" />
        </div>
      </article>
    );
  }

  if (role === "activity") {
    const status = message.activity?.status ?? (message.isPartial ? "running" : "done");
    const isActive = status === "running";
    const activityClass =
      status === "error"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border bg-muted/60 text-muted-foreground";
    return (
      <article data-slot="message-bubble" data-role="activity" className="dev-chat-rail-inset py-1">
        <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full justify-start">
          <div
            data-slot="activity-bubble"
            data-status={status}
            className={`flex w-fit max-w-[88%] min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${activityClass}`}
            aria-live={isActive ? "polite" : undefined}
            style={contentStyle}
          >
            {isActive ? (
              <span
                data-slot="activity-spinner"
                className="relative flex size-3 shrink-0 items-center justify-center text-current"
                aria-hidden="true"
              >
                <span className="absolute size-2 rounded-full bg-current opacity-40 animate-ping" />
                <span className="size-1.5 rounded-full bg-current opacity-80" />
              </span>
            ) : (
              <span
                data-slot="activity-dot"
                className="size-1.5 shrink-0 rounded-full bg-current opacity-60"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 whitespace-pre-wrap break-words">{message.text}</span>
          </div>
        </div>
      </article>
    );
  }

  if (role === "user") {
    const isQueued = message.deliveryStatus === "queued";
    const userBodyClass = message.isPartial
      ? "min-w-0 max-w-[80%] rounded-md border border-dashed border-primary-foreground/40 bg-primary/60 text-primary-foreground/90 px-4 py-2"
      : isQueued
        ? "min-w-0 max-w-[80%] rounded-md border border-dashed border-primary/50 bg-primary/70 text-primary-foreground/90 px-4 py-2"
      : "min-w-0 max-w-[80%] rounded-md bg-primary text-primary-foreground px-4 py-2";
    return (
      <article
        data-slot="message-bubble"
        data-role="user"
        data-partial={message.isPartial ? "true" : undefined}
        className="dev-chat-rail-inset py-2"
      >
        <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full justify-end">
          <div className={userBodyClass} style={contentStyle}>
            <MarkdownView
              text={message.text}
              tone="on-primary"
              trailingInline={streamingCursor}
              preserveSoftBreaks
            />
            {isQueued ? (
              <div
                data-slot="queued-message-status"
                className="mt-1 flex items-center justify-end gap-1 text-[11px] text-primary-foreground/75"
              >
                <Clock3 className="size-3" aria-hidden="true" />
                <span>已排队</span>
              </div>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

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
