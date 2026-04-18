// ChatPage: 根据 ?mode= 渲染 JSON 或 PTY 视图
// PTY 视图由 Plan 10-05 填充; ChatHeader + InputBar + SemanticActionPanel 由 Plan 10-04b 填充
import { useParams, useSearchParams } from "react-router";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { EmptyState } from "@/components/shell/empty-state";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const mode = searchParams.get("mode");

  if (!id) {
    return <EmptyState variant="no-session" />;
  }

  return (
    <div className="flex flex-col h-full">
      <div
        data-slot="chat-header-placeholder"
        className="h-12 px-3 flex items-center border-b border-border text-sm text-muted-foreground"
      >
        Chat: {id}
      </div>
      <div className="flex-1 min-h-0">
        {mode === "pty" ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            PTY 模式待 Plan 10-05 集成
          </div>
        ) : (
          <ChatJsonView sessionId={id} />
        )}
      </div>
    </div>
  );
}
