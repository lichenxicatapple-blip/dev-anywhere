// 回到底部按钮, 仅在 follow-output 被用户打断后显示
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BackToBottomProps {
  visible: boolean;
  hasNewMessages?: boolean;
  onClick: () => void;
}

export function BackToBottom({
  visible,
  hasNewMessages,
  onClick,
}: BackToBottomProps) {
  if (!visible) return null;
  return (
    <Button
      size="icon"
      variant="outline"
      onClick={onClick}
      className="absolute bottom-20 right-4 rounded-full shadow-md"
      aria-label="回到底部"
      data-slot="back-to-bottom"
    >
      <ArrowDown aria-hidden="true" />
      {hasNewMessages && (
        <span
          className={cn(
            "absolute top-0 right-0 -mt-1 -mr-1 w-2 h-2 rounded-full bg-primary",
          )}
          aria-label="有新消息"
        />
      )}
    </Button>
  );
}
