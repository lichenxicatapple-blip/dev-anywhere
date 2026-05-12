// 回到底部按钮, 始终渲染: visible=false 时 opacity:0 + pointer-events:none
// 真正卸载会让 transition-out 没机会跑。用 inert 替代 aria-hidden + tabIndex:
// aria-hidden + tabIndex=-1 不阻止 focus() / 点击后 retained focus, 一旦 button
// 上还有 focus 时 visible 切 false → aria-hidden=true 触发浏览器警告 "Blocked
// aria-hidden on element because its descendant retained focus"。inert 是规范级
// "整子树关闭交互", 自动 blur 掉 stale focus + 对 AT 隐藏 + 阻止 tab/click。
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
      inert={!visible}
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
        // 红点是装饰元素, 永远 aria-hidden 即可; 文案"有新消息"放到外层 button
        // aria-label 上更合适 (但当前 aria-label="回到底部" 就已经说明意图, 红点
        // 状态对 AT 用户不重要)。
        aria-hidden="true"
        className={cn(
          "absolute top-0 right-0 -mt-1 -mr-1 w-2 h-2 rounded-full bg-primary",
          "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          hasNewMessages ? "opacity-100 scale-100" : "opacity-0 scale-0",
        )}
      />
    </Button>
  );
}
