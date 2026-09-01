import { Globe2, Loader2, MoreHorizontal } from "lucide-react";
import type { PreviewState, PreviewSummary } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";

interface PreviewRowProps {
  preview: PreviewSummary;
  onReconnect: () => void;
  onClose: () => void;
}

const STATE_STYLE: Record<
  PreviewState,
  { dot: string; text: string; label: string; busy?: boolean }
> = {
  starting: {
    dot: "bg-[var(--color-status-working)] animate-pulse",
    text: "text-[var(--color-status-working)]",
    label: "正在创建",
    busy: true,
  },
  ready: {
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
    label: "可访问",
  },
  failed: {
    dot: "bg-[var(--color-status-error)]",
    text: "text-[var(--color-status-error)]",
    label: "连接失败",
  },
  disconnected: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    label: "已断开",
  },
  stopping: {
    dot: "bg-muted-foreground animate-pulse",
    text: "text-muted-foreground",
    label: "正在关闭",
    busy: true,
  },
};

function previewSourceLabel(preview: PreviewSummary): string {
  return preview.source.kind === "local"
    ? preview.source.url
    : `${preview.source.rootPath.replace(/\/$/, "")}/${preview.source.entryPath}`;
}

async function copyPreviewLink(url: string): Promise<void> {
  const result = await copyText(url, { allowLegacyFallback: true });
  if (result === "failed") {
    toast.error("复制失败，请稍后重试");
    return;
  }
  toast.success("链接已复制");
}

async function sharePreview(preview: PreviewSummary): Promise<void> {
  if (!preview.publicUrl || typeof navigator.share !== "function") return;
  try {
    await navigator.share({ title: preview.name, url: preview.publicUrl });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    toast.error("无法打开系统分享面板");
  }
}

export function PreviewRow({ preview, onReconnect, onClose }: PreviewRowProps) {
  const style = STATE_STYLE[preview.state];
  const canOpen = preview.state === "ready" && !!preview.publicUrl;
  const canReconnect = preview.state === "failed" || preview.state === "disconnected";
  const canShare =
    canOpen && typeof navigator !== "undefined" && typeof navigator.share === "function";
  const sourceLabel = previewSourceLabel(preview);
  const rowContents = (
    <>
      <span className="flex items-center gap-2 min-w-0">
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
        <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
          title={sourceLabel}
        >
          {sourceLabel}
        </span>
        <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">
          ·
        </span>
        <span className={cn("shrink-0", style.text)}>{style.label}</span>
      </span>
      {preview.error && (preview.state === "failed" || preview.state === "disconnected") ? (
        <span
          data-slot="preview-row-error"
          className="truncate text-xs text-destructive/90"
          title={preview.error}
        >
          {preview.error}
        </span>
      ) : null}
    </>
  );

  return (
    <li
      className="relative flex min-h-[44px] w-full min-w-0 items-center gap-2 px-4 py-2 transition-colors hover:bg-accent"
      data-slot="preview-row"
      data-preview-id={preview.previewId}
      data-preview-state={preview.state}
    >
      {canOpen ? (
        <a
          href={preview.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="preview-row-open"
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
        >
          {rowContents}
        </a>
      ) : (
        <div
          data-slot="preview-row-inactive"
          aria-disabled="true"
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1 md:min-h-0"
        >
          {rowContents}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-11 md:size-6"
            aria-label="预览操作"
            data-slot="preview-row-menu-trigger"
            disabled={preview.state === "stopping"}
          >
            {style.busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <MoreHorizontal aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-slot="preview-row-menu">
          {canOpen && preview.publicUrl ? (
            <DropdownMenuItem
              data-slot="preview-row-copy-item"
              onSelect={() => void copyPreviewLink(preview.publicUrl!)}
            >
              复制链接
            </DropdownMenuItem>
          ) : null}
          {canShare ? (
            <DropdownMenuItem
              data-slot="preview-row-share-item"
              onSelect={() => void sharePreview(preview)}
            >
              分享…
            </DropdownMenuItem>
          ) : null}
          {canReconnect ? (
            <DropdownMenuItem data-slot="preview-row-reconnect-item" onSelect={onReconnect}>
              重新连接
            </DropdownMenuItem>
          ) : null}
          {(canOpen || canReconnect) && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            data-slot="preview-row-close-item"
            onSelect={onClose}
          >
            关闭预览
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
