// ChatPage: 根据 ?mode= 渲染 JSON 或 PTY 视图
// Placeholder 在 Plan 10-04b 被完整 ChatHeader 替换
import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { EmptyState } from "@/components/shell/empty-state";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const mode = searchParams.get("mode");

  if (!id) {
    return <EmptyState variant="no-session" />;
  }

  return (
    <div className="flex flex-col h-full">
      <div
        data-slot="chat-header-placeholder"
        className="h-12 px-3 flex items-center gap-2 border-b border-border text-sm"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate("/sessions")}
          aria-label="返回会话列表"
          data-slot="chat-back-button"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="truncate text-muted-foreground">{id}</span>
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
