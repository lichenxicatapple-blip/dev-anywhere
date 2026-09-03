import { Loader2, MoreHorizontal, Smartphone } from "lucide-react";
import { Link } from "react-router";
import type { DevicePreviewState, DevicePreviewSummary } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface DevicePreviewRowProps {
  preview: DevicePreviewSummary;
  selected: boolean;
  pendingOperation?: "rename" | "reconnect" | "close";
  onRename: () => void;
  onReconnect: () => void;
  onClose: () => void;
}

const STATE_STYLE: Record<
  DevicePreviewState,
  { dot: string; text: string; label: string; busy?: boolean }
> = {
  ready: {
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
    label: "已连接",
  },
  disconnected: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    label: "已断开",
  },
};

export function DevicePreviewRow({
  preview,
  selected,
  pendingOperation,
  onRename,
  onReconnect,
  onClose,
}: DevicePreviewRowProps) {
  const authoritativeStyle = STATE_STYLE[preview.state];
  const style =
    pendingOperation === "reconnect"
      ? {
          dot: "bg-[var(--color-status-working)] animate-pulse",
          text: "text-[var(--color-status-working)]",
          label: "正在重新连接",
          busy: true,
        }
      : pendingOperation === "close"
        ? {
            dot: "bg-muted-foreground animate-pulse",
            text: "text-muted-foreground",
            label: "正在停止",
            busy: true,
          }
        : authoritativeStyle;
  const canOpen = preview.state === "ready";
  const canReconnect = preview.state === "disconnected";
  const platformLabel = preview.platform === "ios" ? "iOS" : "Android";
  const contents = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn("inline-block size-2 shrink-0 rounded-full", style.dot)}
          role="status"
          aria-label={`预览状态：${style.label}`}
        />
        <span className="flex-1 truncate text-sm font-normal" title={preview.name}>
          {preview.name}
        </span>
      </span>
      <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs leading-5">
        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          data-slot="device-preview-row-device"
          data-device-model={preview.model}
          data-os-version={preview.osVersion}
        >
          {preview.model} · {platformLabel} {preview.osVersion}
        </span>
        <span className={cn("shrink-0", style.text)}>{style.label}</span>
      </span>
    </>
  );

  return (
    <li
      className={cn(
        "relative flex min-h-[44px] w-full min-w-0 items-center gap-2 px-4 py-2 transition-colors hover:bg-accent",
        selected && "bg-accent",
      )}
      data-slot="device-preview-row"
      data-preview-id={preview.previewId}
      data-preview-state={preview.state}
      data-preview-operation={pendingOperation}
    >
      {canOpen ? (
        <Link
          to={`/preview/device/${preview.previewId}`}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
          data-slot="device-preview-row-open"
        >
          {contents}
        </Link>
      ) : (
        <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1 md:min-h-0">
          {contents}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-11 md:size-6"
            aria-label="模拟器预览操作"
            disabled={pendingOperation !== undefined}
            data-slot="device-preview-row-menu-trigger"
          >
            {style.busy || pendingOperation === "rename" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <MoreHorizontal aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-slot="device-preview-row-menu">
          <DropdownMenuItem data-slot="device-preview-row-rename-item" onSelect={onRename}>
            重命名
          </DropdownMenuItem>
          {canReconnect ? (
            <DropdownMenuItem data-slot="device-preview-row-reconnect-item" onSelect={onReconnect}>
              重新连接
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-slot="device-preview-row-close-item"
            onSelect={onClose}
          >
            停止预览
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
