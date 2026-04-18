// ChatPage: ChatHeader + StatusLine (4px 色带) + content(JSON/PTY) + QuotePreviewBar + InputBar
// statusState 按优先级聚合 connection/approval/terminated/working/idle，StatusLine 放 Header 正下方
// InputBar 统一承载 JSON 与 PTY 两种模式；右侧不再有 SemanticActionPanel 侧栏
import { useParams, useSearchParams } from "react-router";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { ChatPtyView } from "@/components/chat/chat-pty-view";
import { InputBar } from "@/components/chat/input-bar";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { StatusLine, type StatusLineState } from "@/components/chat/status-line";
import { EmptyState } from "@/components/shell/empty-state";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const mode = (searchParams.get("mode") ?? "json") as "json" | "pty";

  if (!id) {
    return <EmptyState variant="no-session" />;
  }
  return <ChatPageInner id={id} mode={mode} />;
}

function ChatPageInner({ id, mode }: { id: string; mode: "json" | "pty" }) {
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const session = useSessionStore((s) =>
    s.sessions.find((x) => x.sessionId === id),
  );
  const isWorking = useChatStore(
    (s) => s.bySessionId[id]?.isWorking ?? EMPTY_SLICE.isWorking,
  );
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[id]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );

  const statusState: StatusLineState =
    !connected || !proxyOnline
      ? "disconnected"
      : pendingApprovals.some((a) => a.status === "pending")
        ? "waiting_approval"
        : session?.state === "terminated"
          ? "terminated"
          : isWorking
            ? "working"
            : "idle";

  return (
    <div className="flex flex-col h-full">
      <ChatHeader sessionId={id} />
      <StatusLine state={statusState} />
      <div className="flex-1 min-h-0">
        {mode === "pty" ? (
          <ChatPtyView sessionId={id} />
        ) : (
          <ChatJsonView sessionId={id} />
        )}
      </div>
      <QuotePreviewBar sessionId={id} />
      <div
        className="p-2"
        data-slot="input-bar-region"
      >
        <InputBar sessionId={id} mode={mode} />
      </div>
    </div>
  );
}
