import { useEffect, useRef, useState } from "react";
import { Copy, Download, LoaderCircle, RotateCcw, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/toast";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import type { MediaPreviewState } from "./media-preview";

export function VideoPreviewDialog({
  state,
  sessionId,
  onClose,
  onRetry,
}: {
  state: MediaPreviewState;
  sessionId: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  async function downloadVideo() {
    const relay = relayClientRef;
    if (!relay) return;
    const toastId = toast.loading(`下载 ${state.path} ...`);
    try {
      const result = await triggerFileDownload({ relay, sessionId, path: state.path });
      if (result.ok) toast.success(`已开始下载 ${state.path}`, { id: toastId });
      else toast.error(result.error, { id: toastId });
    } catch {
      toast.error("下载失败，请稍后重试", { id: toastId });
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(state.path);
      toast.success("视频路径已复制");
    } catch {
      window.prompt("复制视频路径", state.path);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="dev-image-preview-dialog !top-0 !left-0 grid h-dvh min-w-0 max-h-dvh !max-w-none !translate-x-0 !translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden !rounded-none !border-0 !px-3 !pt-3 !pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:!top-[50%] sm:!left-[50%] sm:h-[min(80dvh,760px)] sm:!w-[min(92vw,72rem)] sm:max-h-[calc(100dvh-2rem)] sm:!max-w-[calc(100vw-2rem)] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!rounded-lg sm:!border sm:!border-border/35 sm:!px-4 sm:!pt-4 sm:!shadow-xl"
        data-slot="video-preview-dialog"
        focusSurfaceOnOpen
        showCloseButton={false}
      >
        <DialogClose
          className="group absolute top-1 right-1 z-30 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="关闭视频预览"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-sm ring-1 ring-border/40 group-hover:bg-accent group-hover:text-foreground">
            <XIcon className="size-3.5" aria-hidden="true" />
          </span>
        </DialogClose>
        <DialogHeader className="min-w-0 max-w-full pr-10 text-left">
          <DialogTitle className="text-base">视频预览</DialogTitle>
          <DialogDescription
            className="block min-w-0 truncate font-mono text-xs leading-5"
            title={state.path}
          >
            {state.path}
          </DialogDescription>
        </DialogHeader>
        <div
          className="relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md bg-black"
          data-slot="video-preview-stage"
        >
          {state.status === "loading" && <VideoLoading label="正在从开发机读取视频..." />}
          {state.status === "error" && (
            <VideoError message={state.error ?? "视频预览失败"} onRetry={onRetry} />
          )}
          {state.status === "ready" && state.url && (
            <VideoPlayer key={state.url} src={state.url} onRetry={onRetry} />
          )}
        </div>
        <div className="flex min-w-0 justify-end gap-2" data-slot="video-preview-footer">
          <Button
            className="flex-1 sm:flex-none"
            variant="outline"
            size="sm"
            onClick={() => void downloadVideo()}
          >
            <Download aria-hidden="true" />
            下载
          </Button>
          <Button
            className="flex-1 sm:flex-none"
            variant="outline"
            size="sm"
            onClick={() => void copyPath()}
          >
            <Copy aria-hidden="true" />
            复制路径
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VideoPlayer({ src, onRetry }: { src: string; onRetry: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    // Restore the source when React replays effects in development StrictMode.
    if (video && video.getAttribute("src") !== src) video.setAttribute("src", src);
    return () => {
      // Keepalive sessions remain mounted; removing the source also cancels active range requests.
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return (
    <>
      {!ready && !error && <VideoLoading label="正在加载视频..." />}
      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label="视频播放器"
        data-slot="video-preview-player"
        className={error ? "hidden" : "h-full w-full min-w-0 object-contain"}
        onLoadedMetadata={() => setReady(true)}
        onError={(event) => {
          const code = event.currentTarget.error?.code;
          if (code === 3 || code === 4) {
            setError("浏览器无法播放这个视频格式或编码，可以下载后用本地播放器打开。");
          } else {
            setError("视频加载失败，请重试或下载后播放。");
          }
        }}
      />
      {error && <VideoError message={error} onRetry={onRetry} />}
    </>
  );
}

function VideoLoading({ label }: { label: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 p-5 text-sm text-white/80"
      role="status"
    >
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

function VideoError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="max-w-sm space-y-3 p-5 text-center text-white" role="alert">
      <p className="text-sm font-medium">无法预览这个视频</p>
      <p className="text-xs leading-relaxed text-white/70">{message}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        重试
      </Button>
    </div>
  );
}
