// 回到底部按钮, 始终渲染: visible=false 时 opacity:0 + pointer-events:none
// 真正卸载会让 transition-out 没机会跑, 不卸载也能脱离 tab 序与屏幕阅读器
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BackToBottomProps {
  visible: boolean;
  hasNewMessages?: boolean;
  onClick: () => void;
  className?: string;
}

export function BackToBottom({ visible, hasNewMessages, onClick, className }: BackToBottomProps) {
  return (
    <Button
      size="icon"
      variant="outline"
      onClick={onClick}
      aria-label="回到底部"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      data-slot="back-to-bottom"
      className={cn(
        "absolute bottom-4 right-4 rounded-full shadow-md z-10",
        "transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        className,
      )}
    >
      <ArrowDown aria-hidden="true" />
      <span
        aria-hidden={!hasNewMessages}
        aria-label={hasNewMessages ? "有新消息" : undefined}
        className={cn(
          "absolute top-0 right-0 -mt-1 -mr-1 w-2 h-2 rounded-full bg-primary",
          "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          hasNewMessages ? "opacity-100 scale-100" : "opacity-0 scale-0",
        )}
      />
    </Button>
  );
}
