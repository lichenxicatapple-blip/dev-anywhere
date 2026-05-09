// JSON InputBar 的菜单壳: 桌面 Popover, 移动 BottomSheet
// Sheet 版用 drag handle 代替大标题, toggle 提亮 off 态避免暗背景下不可见
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";

interface MenuBodyProps {
  variant: "popover" | "sheet";
}

function MenuBody({ variant }: MenuBodyProps) {
  // sheet 项偏大 touch-friendly, popover 保持紧凑
  const itemH = variant === "sheet" ? "h-12" : "h-9";
  const itemPad = variant === "sheet" ? "px-4" : "px-2";

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
export function InputMenu() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label="更多"
            data-slot="input-menu-trigger"
          >
            <SlidersHorizontal aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-1">
          <MenuBody variant="popover" />
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
          className="size-11 md:size-9"
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
        <MenuBody variant="sheet" />
      </SheetContent>
    </Sheet>
  );
}
