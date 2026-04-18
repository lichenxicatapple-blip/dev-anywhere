// 引用预览条: 出现在 InputBar 上方, 可单击 X 取消引用
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chat-store";

interface QuotePreviewBarProps {
  sessionId: string;
}

export function QuotePreviewBar({ sessionId }: QuotePreviewBarProps) {
  const quote = useChatStore((s) => s.bySessionId[sessionId]?.quotedMessage ?? null);
  const setQuotedMessage = useChatStore((s) => s.setQuotedMessage);

  if (!quote) return null;

  return (
    <div
      className="flex items-start gap-2 px-3 py-2 bg-muted border-t border-border"
      data-slot="quote-preview-bar"
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">
          {quote.from === "assistant" ? "Claude:" : "You:"}
        </div>
        <div className="text-xs line-clamp-2">{quote.text}</div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => setQuotedMessage(sessionId, null)}
        aria-label="取消引用"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
