// ChatPage: ChatHeader (D-51 三件套) + 根据 ?mode= 渲染 JSON 或 PTY 视图
// JSON 模式: ChatJsonView 自带 InputBar + SemanticActionPanel + QuotePreviewBar
// PTY 模式: ChatPtyView 自包含 xterm; InputBar/SemanticActionPanel/QuotePreviewBar 作为 sibling 拼装
import { useParams, useSearchParams } from "react-router";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { ChatPtyView } from "@/components/chat/chat-pty-view";
import { InputBar } from "@/components/chat/input-bar";
import { SemanticActionPanel } from "@/components/chat/semantic-action-panel";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { EmptyState } from "@/components/shell/empty-state";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const mode = (searchParams.get("mode") ?? "json") as "json" | "pty";

  if (!id) {
    return <EmptyState variant="no-session" />;
  }

  if (mode === "pty") {
    return (
      <div className="flex flex-col h-full">
        <ChatHeader sessionId={id} />
        <div className="flex-1 min-h-0">
          <ChatPtyView sessionId={id} />
        </div>
        <QuotePreviewBar sessionId={id} />
        <div
          className="flex items-end gap-2 p-2 border-t border-border"
          data-slot="input-bar-region"
        >
          <InputBar sessionId={id} mode="pty" />
          <SemanticActionPanel sessionId={id} mode="pty" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ChatHeader sessionId={id} />
      <div className="flex-1 min-h-0">
        <ChatJsonView sessionId={id} />
      </div>
    </div>
  );
}
