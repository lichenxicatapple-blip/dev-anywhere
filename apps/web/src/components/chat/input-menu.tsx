// InputBar 的"更多功能"菜单壳：桌面走 Popover、移动走 BottomSheet
// PTY 专属项: 切换权限模式 (Shift+Tab 循环) / 终端字号自适应; JSON 当前只有占位
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAppStore } from "@/stores/app-store";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface InputMenuProps {
  sessionId: string;
  mode: "json" | "pty";
}

interface MenuBodyProps {
  mode: "json" | "pty";
  sessionId: string;
  onAfterAction: () => void;
}

function MenuBody({ mode, sessionId, onAfterAction }: MenuBodyProps) {
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const setPtyAutoscale = useAppStore((s) => s.setPtyAutoscale);

  if (mode === "pty") {
    return (
      <div
        className="flex flex-col gap-1 p-2"
        data-slot="input-menu-content"
      >
        <button
          type="button"
          onClick={() => {
            // Claude CLI 仅支持 Shift+Tab 循环 default → auto-accept → plan
            // mode 字段保留在 schema 里但不携带真实目标档, 由 proxy 触发循环键
            relayClientRef?.sendControl({
              type: "permission_mode_change",
              mode: "default",
              sessionId,
            });
            onAfterAction();
          }}
          className="flex items-center gap-3 rounded-sm px-2 py-2 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-slot="input-menu-permission-cycle"
        >
          <span className="flex-1 text-left">切换权限模式</span>
        </button>
        <button
          type="button"
          onClick={() => setPtyAutoscale(!ptyAutoscale)}
          className="flex items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="switch"
          aria-checked={ptyAutoscale}
        >
          <span className="flex-1 text-left">终端字号自适应</span>
          <span
            aria-hidden="true"
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              ptyAutoscale ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute h-4 w-4 rounded-full bg-background shadow transition-transform",
                ptyAutoscale ? "translate-x-[18px]" : "translate-x-[2px]",
              )}
            />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-1 p-2"
      data-slot="input-menu-content"
    >
      <div
        className="flex items-center px-2 py-2 text-sm text-muted-foreground opacity-50 cursor-not-allowed"
        aria-disabled="true"
      >
        更多功能即将加入
      </div>
    </div>
  );
}

// Radix asChild 会把 onClick / ref 透传到直接 child element，如果再包一层函数组件
// 而不 forwardRef + 不 spread props，就会把透传吞掉，点击无效。这里直接内联 Button
export function InputMenu({ sessionId, mode }: InputMenuProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="更多"
            data-slot="input-menu-trigger"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-0">
          <MenuBody mode={mode} sessionId={sessionId} onAfterAction={close} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="更多"
          data-slot="input-menu-trigger"
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-auto">
        <SheetHeader>
          <SheetTitle>更多功能</SheetTitle>
        </SheetHeader>
        <MenuBody mode={mode} sessionId={sessionId} onAfterAction={close} />
      </SheetContent>
    </Sheet>
  );
}
