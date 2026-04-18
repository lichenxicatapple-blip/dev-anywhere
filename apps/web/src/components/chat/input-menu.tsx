// InputBar 的"更多功能"菜单壳：桌面走 Popover、移动走 BottomSheet
// 10-08 首版只放占位项 "更多功能即将加入"；后续 plan 往这里塞 Resume / 清屏 / 字号等
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
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

interface InputMenuProps {
  sessionId: string;
  mode: "json" | "pty";
}

function MenuBody({ mode: _mode }: { mode: "json" | "pty" }) {
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

function TriggerButton() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="更多"
      data-slot="input-menu-trigger"
    >
      <MoreHorizontal aria-hidden="true" />
    </Button>
  );
}

export function InputMenu({ sessionId: _sessionId, mode }: InputMenuProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <TriggerButton />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-0">
          <MenuBody mode={mode} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <TriggerButton />
      </SheetTrigger>
      <SheetContent side="bottom" className="h-auto">
        <SheetHeader>
          <SheetTitle>更多功能</SheetTitle>
        </SheetHeader>
        <MenuBody mode={mode} />
      </SheetContent>
    </Sheet>
  );
}
