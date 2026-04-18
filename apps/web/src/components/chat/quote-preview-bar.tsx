// 引用预览条: 出现在 InputBar 上方, 可单击 X 取消引用
// sessionId prop 为 Plan 10-06 per-session store 切换预留 (当前 flat store 未使用)
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chat-store";

interface QuotePreviewBarProps {
  sessionId: string;
}

export function QuotePreviewBar(_props: QuotePreviewBarProps) {
  const quote = useChatStore((s) => s.quotedMessage);
  const clearQuote = useChatStore((s) => s.clearQuote);

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
        onClick={() => clearQuote()}
        aria-label="取消引用"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
