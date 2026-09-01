import { useEffect, useState } from "react";
import { Globe2, Smartphone } from "lucide-react";
import type { DevicePreviewPlatform } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { CreateWebPreviewDialog } from "./create-web-preview-dialog";
import { CreateDevicePreviewDialog } from "./create-device-preview-dialog";

interface CreateFrontendPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Choice = "web" | DevicePreviewPlatform | null;

export function CreateFrontendPreviewDialog({
  open,
  onOpenChange,
}: CreateFrontendPreviewDialogProps) {
  const [choice, setChoice] = useState<Choice>(null);
  const isDesktop = useMediaQuery("(min-width: 768px)");

  useEffect(() => {
    if (open) setChoice(null);
  }, [open]);

  function close(): void {
    setChoice(null);
    onOpenChange(false);
  }

  const choices = (
    <div className="grid gap-2 pt-2" data-slot="frontend-preview-options">
      <PreviewChoice
        icon={<Globe2 className="size-5" aria-hidden="true" />}
        title="网页"
        description="通过临时链接访问或分享本机网页"
        slot="frontend-preview-web"
        onClick={() => setChoice("web")}
      />
      <PreviewChoice
        icon={<Smartphone className="size-5" aria-hidden="true" />}
        title="iOS Simulator"
        description="查看和操控开发机上已启动的 iPhone 或 iPad 模拟器"
        slot="frontend-preview-ios"
        onClick={() => setChoice("ios")}
      />
      <PreviewChoice
        icon={<Smartphone className="size-5" aria-hidden="true" />}
        title="Android Emulator"
        description="查看和操控开发机上已启动的 Android 模拟器"
        slot="frontend-preview-android"
        onClick={() => setChoice("android")}
      />
    </div>
  );

  return (
    <>
      {isDesktop ? (
        <Dialog open={open && choice === null} onOpenChange={(next) => !next && close()}>
          <DialogContent className="sm:max-w-lg" data-slot="create-frontend-preview-dialog">
            <DialogHeader>
              <DialogTitle>新建前端预览</DialogTitle>
              <DialogDescription>选择预览类型。</DialogDescription>
            </DialogHeader>
            {choices}
          </DialogContent>
        </Dialog>
      ) : (
        <Sheet open={open && choice === null} onOpenChange={(next) => !next && close()}>
          <SheetContent
            side="bottom"
            className="inset-x-2 w-auto rounded-t-xl border bg-background px-4 pb-[max(theme(spacing.4),env(safe-area-inset-bottom))] pt-3"
            data-slot="create-frontend-preview-dialog"
            focusSurfaceOnOpen
          >
            <SheetHeader className="px-0 pb-1 pt-0 text-left">
              <SheetTitle>新建前端预览</SheetTitle>
              <SheetDescription>选择预览类型。</SheetDescription>
            </SheetHeader>
            {choices}
          </SheetContent>
        </Sheet>
      )}

      <CreateWebPreviewDialog
        open={open && choice === "web"}
        onOpenChange={(next) => !next && close()}
      />
      <CreateDevicePreviewDialog
        open={open && (choice === "ios" || choice === "android")}
        platform={choice === "ios" || choice === "android" ? choice : "ios"}
        onOpenChange={(next) => !next && close()}
      />
    </>
  );
}

function PreviewChoice({
  icon,
  title,
  description,
  slot,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  slot: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-[4.5rem] justify-start gap-3 px-4 py-3 text-left"
      data-slot={slot}
      onClick={onClick}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block whitespace-normal text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
  );
}
