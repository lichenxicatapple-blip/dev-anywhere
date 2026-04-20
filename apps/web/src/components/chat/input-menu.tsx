// InputBar 的菜单壳: 桌面 Popover, 移动 BottomSheet
// Sheet 版用 drag handle 代替大标题, toggle 提亮 off 态避免暗背景下不可见
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
  variant: "popover" | "sheet";
  onAfterAction: () => void;
}

function MenuBody({ mode, sessionId, variant, onAfterAction }: MenuBodyProps) {
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const setPtyAutoscale = useAppStore((s) => s.setPtyAutoscale);

  // sheet 项偏大 touch-friendly, popover 保持紧凑
  const itemH = variant === "sheet" ? "h-12" : "h-9";
  const itemPad = variant === "sheet" ? "px-4" : "px-2";

  if (mode === "pty") {
    return (
      <div className="flex flex-col" data-slot="input-menu-content">
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
          className={cn(
            "flex items-center gap-3 text-sm text-foreground hover:bg-accent active:bg-accent/80 focus-visible:outline-none focus-visible:bg-accent transition-colors",
            itemH,
            itemPad,
          )}
          data-slot="input-menu-permission-cycle"
        >
          <span className="flex-1 text-left">切换权限模式</span>
        </button>
        <button
          type="button"
          onClick={() => setPtyAutoscale(!ptyAutoscale)}
          className={cn(
            "flex items-center justify-between gap-3 text-sm text-foreground hover:bg-accent active:bg-accent/80 focus-visible:outline-none focus-visible:bg-accent transition-colors",
            itemH,
            itemPad,
          )}
          role="switch"
          aria-checked={ptyAutoscale}
        >
          <span className="flex-1 text-left">终端字号自适应</span>
          <span
            aria-hidden="true"
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
              ptyAutoscale ? "bg-primary border-primary" : "bg-input border-border",
            )}
          >
            <span
              className={cn(
                "absolute h-4 w-4 rounded-full shadow-sm transition-transform",
                ptyAutoscale
                  ? "bg-primary-foreground translate-x-[22px]"
                  : "bg-foreground translate-x-[3px]",
              )}
            />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn("flex items-center text-sm text-muted-foreground", itemH, itemPad)}
      aria-disabled="true"
      data-slot="input-menu-content"
    >
      更多功能即将加入
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
            <SlidersHorizontal aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-1">
          <MenuBody mode={mode} sessionId={sessionId} variant="popover" onAfterAction={close} />
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
          <SlidersHorizontal aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-auto gap-0 rounded-t-xl bg-popover pt-2 pb-[max(theme(spacing.2),env(safe-area-inset-bottom))] border-t-0"
      >
        {/* sr-only title 给 Radix Dialog a11y, 视觉上交给 drag handle */}
        <VisuallyHidden.Root>
          <SheetTitle>会话控制</SheetTitle>
        </VisuallyHidden.Root>
        <div
          aria-hidden="true"
          className="mx-auto mb-1 h-1 w-10 rounded-full bg-border"
          data-slot="sheet-drag-handle"
        />
        <MenuBody mode={mode} sessionId={sessionId} variant="sheet" onAfterAction={close} />
      </SheetContent>
    </Sheet>
  );
}
