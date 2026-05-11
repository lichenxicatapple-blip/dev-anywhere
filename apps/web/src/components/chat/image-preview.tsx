import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Copy, Download, Image as ImageIcon, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { extractImagePreviewPaths } from "@/lib/image-preview-path";
import { cn } from "@/lib/utils";
import { toast } from "@/components/toast";

type ImagePreviewStatus = "idle" | "loading" | "ready" | "error";

type ImagePreviewState = {
  status: ImagePreviewStatus;
  path: string;
  mimeType?: string;
  dataBase64?: string;
  size?: number;
  error?: string;
};

type ImagePreviewContextValue = {
  openImagePreview: (path: string) => void;
};

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export function useImagePreview(): ImagePreviewContextValue {
  return useContext(ImagePreviewContext) ?? { openImagePreview: () => undefined };
}

export function ImagePreviewProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ImagePreviewState>({ status: "idle", path: "" });
  const requestSeqRef = useRef(0);

  const openImagePreview = useCallback(
    (path: string): void => {
      const relay = relayClientRef;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      setOpen(true);
      setState({ status: "loading", path });

      if (!relay) {
        setState({ status: "error", path, error: "请先连接开发机" });
        return;
      }

      void relay
        .requestImagePreview(sessionId, path)
        .then((result) => {
          if (requestSeqRef.current !== requestSeq) return;
          if (!result.success || !result.mimeType || !result.dataBase64) {
            setState({
              status: "error",
              path,
              error: result.error ?? "图片预览失败",
            });
            return;
          }
          setState({
            status: "ready",
            path: result.path || path,
            mimeType: result.mimeType,
            dataBase64: result.dataBase64,
            size: result.size,
          });
        })
        .catch((err: unknown) => {
          if (requestSeqRef.current !== requestSeq) return;
          setState({
            status: "error",
            path,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [sessionId],
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    setOpen(false);
    setState({ status: "idle", path: "" });
  }, [sessionId]);

  const value = useMemo(() => ({ openImagePreview }), [openImagePreview]);

  return (
    <ImagePreviewContext.Provider value={value}>
      {children}
      <ImagePreviewDialog open={open} onOpenChange={setOpen} state={state} />
    </ImagePreviewContext.Provider>
  );
}

export function ImagePreviewLinks({
  text,
  tone = "default",
}: {
  text: string;
  tone?: "default" | "on-primary";
}) {
  const paths = extractImagePreviewPaths(text);
  const { openImagePreview } = useImagePreview();
  if (paths.length === 0) return null;

  return (
    <div className="not-prose mt-2 flex flex-wrap gap-1.5" data-slot="image-preview-links">
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-1 text-xs transition-colors",
            tone === "on-primary"
              ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/16"
              : "border-border bg-muted/45 text-foreground hover:bg-accent hover:text-accent-foreground",
          )}
          title={path}
          data-slot="image-preview-link"
          onClick={() => openImagePreview(path)}
        >
          <ImageIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{path}</span>
        </button>
      ))}
    </div>
  );
}

function ImagePreviewDialog({
  open,
  onOpenChange,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ImagePreviewState;
}) {
  const [loadedSrc, setLoadedSrc] = useState("");
  const [decodeError, setDecodeError] = useState<{ src: string; message: string } | null>(null);
  // "actual" 模式下取消 fit 约束, 容器允许滚动平移; 切回时回到 object-contain。
  // 切换通过点击图片或工具栏按钮触发, 也覆盖移动端大图无法看完整的诉求。
  const [zoomMode, setZoomMode] = useState<"fit" | "actual">("fit");
  const src =
    state.status === "ready" && state.mimeType && state.dataBase64
      ? `data:${state.mimeType};base64,${state.dataBase64}`
      : "";
  const imageLoaded = src !== "" && loadedSrc === src;
  const decodeErrorMessage = decodeError?.src === src ? decodeError.message : "";
  const showDecodeError = state.status === "ready" && decodeErrorMessage !== "";
  const showLoading =
    state.status === "loading" || (state.status === "ready" && !imageLoaded && !showDecodeError);

  useEffect(() => {
    setLoadedSrc((current) => (current === src ? current : ""));
    setZoomMode("fit");
  }, [src]);

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(state.path);
      toast.success("图片路径已复制");
    } catch {
      window.prompt("Copy image path", state.path);
    }
  }

  function downloadImage(): void {
    if (!src) return;
    const fileName = state.path.split(/[\\/]/).pop() || "image";
    const a = document.createElement("a");
    a.href = src;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="dev-image-preview-dialog !top-0 !left-0 grid h-dvh max-h-dvh !max-w-none !translate-x-0 !translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 !rounded-none !border-0 !p-3 sm:!top-[50%] sm:!left-[50%] sm:h-[min(80dvh,760px)] sm:max-h-[calc(100dvh-2rem)] sm:!max-w-5xl sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!rounded-lg sm:!border sm:!p-4"
        data-slot="image-preview-dialog"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-base">图片预览</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={state.path}>
            {state.path || "等待图片路径"}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            "dev-image-preview-stage relative flex min-h-[18rem] min-w-0 rounded-md border border-border/70 max-sm:min-h-0",
            zoomMode === "fit"
              ? "items-center justify-center overflow-hidden"
              : "items-start justify-start overflow-auto",
          )}
          data-slot="image-preview-stage"
          data-zoom-mode={zoomMode}
          aria-busy={showLoading}
        >
          {showLoading && <ImagePreviewLoading dimmed={state.status === "ready"} />}
          {state.status === "error" && <ImagePreviewError error={state.error ?? "图片预览失败"} />}
          {showDecodeError && <ImagePreviewError error={decodeErrorMessage} />}
          {state.status === "ready" && !showDecodeError && (
            <img
              src={src}
              alt={state.path}
              className={cn(
                "relative z-10 translate-y-1 cursor-zoom-in opacity-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] data-[loaded=true]:translate-y-0 data-[loaded=true]:opacity-100 motion-reduce:transition-none",
                zoomMode === "fit" ? "max-h-full max-w-full object-contain" : "cursor-zoom-out",
              )}
              data-slot="image-preview-img"
              data-loaded={imageLoaded ? "true" : "false"}
              onClick={() =>
                setZoomMode((prev) => (prev === "fit" ? "actual" : "fit"))
              }
              onLoad={(event) => {
                event.currentTarget.dataset.loaded = "true";
                setLoadedSrc(src);
              }}
              onError={() => {
                setDecodeError({
                  src,
                  message: "浏览器无法解码这张图片，请确认文件没有损坏",
                });
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-slot="image-preview-meta"
          >
            {state.status === "ready" && state.size !== undefined
              ? `${state.mimeType} · ${formatBytes(state.size)}`
              : state.status === "loading"
                ? "正在从开发机读取图片..."
                : " "}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setZoomMode((prev) => (prev === "fit" ? "actual" : "fit"))}
              disabled={state.status !== "ready" || showDecodeError}
              aria-label={zoomMode === "fit" ? "切到原始尺寸 (可滚动查看完整图)" : "回到适应窗口"}
              data-slot="image-preview-zoom-toggle"
            >
              {zoomMode === "fit" ? (
                <>
                  <Maximize2 aria-hidden="true" />
                  原始尺寸
                </>
              ) : (
                <>
                  <Minimize2 aria-hidden="true" />
                  适应窗口
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadImage}
              disabled={!src || showDecodeError}
              data-slot="image-preview-download"
            >
              <Download aria-hidden="true" />
              下载
            </Button>
            <Button variant="outline" size="sm" onClick={copyPath} disabled={!state.path}>
              <Copy aria-hidden="true" />
              复制路径
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreviewLoading({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-0 flex h-full w-full flex-col items-center justify-center gap-4 p-8 transition-opacity duration-200 motion-reduce:transition-none",
        dimmed && "opacity-55",
      )}
      data-slot="image-preview-loading"
      role="status"
      aria-live="polite"
    >
      <div className="dev-image-preview-loading-card dev-image-preview-shimmer flex h-48 w-full max-w-md items-center justify-center rounded-md border border-border/55 shadow-inner">
        <ImageIcon aria-hidden="true" className="relative z-10 size-8 text-muted-foreground/70" />
      </div>
      <div className="flex w-full max-w-xs flex-col items-center gap-2">
        <div className="h-2 w-44 rounded-full bg-muted-foreground/20">
          <div className="dev-image-preview-shimmer h-full w-full rounded-full bg-primary/20" />
        </div>
        <span className="text-xs text-muted-foreground">正在从开发机读取图片...</span>
      </div>
    </div>
  );
}

function ImagePreviewError({ error }: { error: string }) {
  return (
    <div className="max-w-sm px-5 text-center" data-slot="image-preview-error" role="alert">
      <p className="text-sm font-medium">无法预览这张图片</p>
      <p className="mt-2 text-xs text-muted-foreground">{error}</p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
