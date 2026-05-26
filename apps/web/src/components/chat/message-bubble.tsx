import { ChevronDown, Clock3 } from "lucide-react";
import { memo, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMessage } from "@/stores/chat-store";
import { ActivityDetailView } from "./activity-detail-view";
import { MarkdownView } from "./markdown-view";

interface MessageBubbleProps {
  message: ChatMessage;
  contentFontSize?: number;
  turnControl?: ReactNode;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  contentFontSize,
  turnControl,
}: MessageBubbleProps) {
  const role = message.role;
  const contentStyle = contentFontSize ? { fontSize: contentFontSize } : undefined;
  const [activityDetailsOpen, setActivityDetailsOpen] = useState(false);

  const streamingCursor =
    role === "user" && message.isPartial ? (
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
        ? "border-[var(--color-status-warning)]/40 bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)]"
        : "border-border bg-muted/60 text-muted-foreground";
    const activityDetails = message.activity?.details?.filter((item) => item.content.length) ?? [];
    const detailsId = `${message.id}-activity-details`;
    return (
      <article data-slot="message-bubble" data-role="activity" className="dev-chat-rail-inset py-1">
        <div data-slot="message-row" className="dev-message-rail mx-auto flex w-full justify-start">
          <div
            data-slot="activity-bubble"
            data-status={status}
            className={`w-fit max-w-[88%] min-w-0 rounded-md border px-3 py-1.5 text-xs ${activityClass}`}
            aria-live={isActive ? "polite" : undefined}
            style={contentStyle}
          >
            <div className="flex min-w-0 items-center gap-2">
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
              <span
                data-slot="activity-text"
                className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {message.text}
              </span>
              {activityDetails.length > 0 ? (
                <button
                  type="button"
                  className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded text-current/80 hover:bg-current/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={activityDetailsOpen ? "收起工具详情" : "展开工具详情"}
                  aria-expanded={activityDetailsOpen}
                  aria-controls={detailsId}
                  onClick={() => setActivityDetailsOpen((open) => !open)}
                >
                  <ChevronDown
                    className={`size-3.5 transition-transform ${activityDetailsOpen ? "" : "-rotate-90"}`}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              {turnControl ? (
                <span
                  data-slot="activity-turn-control"
                  className="ml-1 flex shrink-0 items-center border-l border-current/15 pl-1"
                >
                  {turnControl}
                </span>
              ) : null}
            </div>
            {activityDetailsOpen && activityDetails.length > 0 ? (
              <div
                id={detailsId}
                data-slot="activity-details"
                className="mt-2 space-y-2 border-t border-current/15 pt-2"
              >
                {activityDetails.map((item, index) => (
                  <ActivityDetailView key={`${item.title}-${index}`} detail={item} />
                ))}
              </div>
            ) : null}
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
          {turnControl ? (
            <div data-slot="assistant-turn-control" className="mt-2 flex justify-end">
              {turnControl}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
});
