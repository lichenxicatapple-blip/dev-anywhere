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
import { Copy, Download, Image as ImageIcon } from "lucide-react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { describeControlError } from "@/lib/control-error-message";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { cn } from "@/lib/utils";
import { toast } from "@/components/toast";

type ImagePreviewStatus = "idle" | "loading" | "ready" | "error";

type ImagePreviewState = {
  status: ImagePreviewStatus;
  path: string;
  url?: string;
  size?: number;
  error?: string;
};

type ImagePreviewSize = {
  width: number;
  height: number;
};

type ImagePreviewNaturalSize = ImagePreviewSize & {
  src: string;
};

type ImagePreviewContextValue = {
  openImagePreview: (path: string) => void;
};

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);
const NOOP_IMAGE_PREVIEW_CONTEXT: ImagePreviewContextValue = {
  openImagePreview: () => undefined,
};

export function useImagePreview(): ImagePreviewContextValue {
  return useContext(ImagePreviewContext) ?? NOOP_IMAGE_PREVIEW_CONTEXT;
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
        .requestRemoteFileUrl(sessionId, path, "inline")
        .then((result) => {
          if (requestSeqRef.current !== requestSeq) return;
          if (!result.success || !result.url) {
            setState({
              status: "error",
              path,
              error: describeControlError({
                errorCode: result.errorCode,
                rawError: result.error,
                fallback: "图片预览失败",
              }),
            });
            return;
          }
          setState({
            status: "ready",
            path: result.path || path,
            url: result.url,
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
      <ImagePreviewDialog open={open} onOpenChange={setOpen} sessionId={sessionId} state={state} />
    </ImagePreviewContext.Provider>
  );
}

function ImagePreviewDialog({
  open,
  onOpenChange,
  sessionId,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  state: ImagePreviewState;
}) {
  const [loadedSrc, setLoadedSrc] = useState("");
  const [decodeError, setDecodeError] = useState<{ src: string; message: string } | null>(null);
  const [stageSize, setStageSize] = useState<ImagePreviewSize | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImagePreviewNaturalSize | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const src = state.status === "ready" && state.url ? state.url : "";
  const imageLoaded = src !== "" && loadedSrc === src;
  const currentNaturalSize = naturalSize?.src === src ? naturalSize : null;
  const fitScale = getImagePreviewFitScale(stageSize, currentNaturalSize);
  const decodeErrorMessage = decodeError?.src === src ? decodeError.message : "";
  const showDecodeError = state.status === "ready" && decodeErrorMessage !== "";
  const showLoading =
    state.status === "loading" || (state.status === "ready" && !imageLoaded && !showDecodeError);
  const loadingLabel = state.status === "ready" ? "正在加载图片..." : "正在从开发机读取图片...";
  const metaText = getImagePreviewMetaText(state, imageLoaded, showDecodeError);
  const transformKey = `${src}:${fitScale}`;
  const imageContentStyle = currentNaturalSize
    ? { width: currentNaturalSize.width, height: currentNaturalSize.height }
    : undefined;

  useEffect(() => {
    setLoadedSrc((current) => (current === src ? current : ""));
  }, [src]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize((current) => {
        const next = { width: rect.width, height: rect.height };
        if (
          current &&
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
        ) {
          return current;
        }
        return next;
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(stage);
    return () => resizeObserver.disconnect();
  }, [open, state.status]);

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(state.path);
      toast.success("图片路径已复制");
    } catch {
      window.prompt("Copy image path", state.path);
    }
  }

  async function downloadImage(): Promise<void> {
    const relay = relayClientRef;
    if (!relay || !state.path) return;
    const toastId = toast.loading(`下载 ${state.path} ...`);
    const result = await triggerFileDownload({ relay, sessionId, path: state.path });
    if (result.ok) toast.success(`已开始下载 ${state.path}`, { id: toastId });
    else toast.error(result.error, { id: toastId });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="dev-image-preview-dialog !top-0 !left-0 grid h-dvh min-w-0 max-h-dvh !max-w-none !translate-x-0 !translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden !rounded-none !border-0 !p-3 sm:!top-[50%] sm:!left-[50%] sm:h-[min(80dvh,760px)] sm:!w-[min(92vw,72rem)] sm:max-h-[calc(100dvh-2rem)] sm:!max-w-[calc(100vw-2rem)] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!rounded-lg sm:!border sm:!p-4"
        data-slot="image-preview-dialog"
        focusSurfaceOnOpen
      >
        <DialogHeader className="min-w-0 max-w-full pr-10 text-left">
          <DialogTitle className="min-w-0 text-base">图片预览</DialogTitle>
          <DialogDescription
            className="block min-w-0 max-w-full truncate font-mono text-xs leading-5"
            title={state.path}
          >
            {state.path || "等待图片路径"}
          </DialogDescription>
        </DialogHeader>

        <div
          className="dev-image-preview-stage relative flex min-h-[18rem] w-full min-w-0 max-w-full items-center justify-center overflow-hidden rounded-md border border-border/70 max-sm:min-h-0"
          data-slot="image-preview-stage"
          aria-busy={showLoading}
          ref={stageRef}
        >
          {showLoading && (
            <ImagePreviewLoading dimmed={state.status === "ready"} label={loadingLabel} />
          )}
          {state.status === "error" && <ImagePreviewError error={state.error ?? "图片预览失败"} />}
          {showDecodeError && <ImagePreviewError error={decodeErrorMessage} />}
          {state.status === "ready" && !showDecodeError && (
            // wheel / pinch / drag 一起承担缩放 + 平移; doubleClick reset 回 fit。
            // 初始 scale 按图片自然尺寸和 stage 尺寸计算，避免移动端宽图以 1:1
            // 内容尺寸进入 transform 后被裁切且无法横向移动。
            <TransformWrapper
              key={transformKey}
              initialScale={fitScale}
              minScale={fitScale}
              maxScale={8}
              centerOnInit
              centerZoomedOut
              limitToBounds
              wheel={{ step: 0.15 }}
              pinch={{ step: 5 }}
              doubleClick={{ mode: "reset" }}
            >
              <TransformComponent
                wrapperClass="!h-full !w-full"
                contentClass="flex items-center justify-center"
                contentStyle={imageContentStyle}
              >
                <img
                  src={src}
                  alt={state.path}
                  className="relative z-10 block h-auto max-h-none max-w-none translate-y-1 object-contain opacity-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] data-[loaded=true]:translate-y-0 data-[loaded=true]:opacity-100 motion-reduce:transition-none"
                  data-slot="image-preview-img"
                  data-loaded={imageLoaded ? "true" : "false"}
                  draggable={false}
                  onLoad={(event) => {
                    setNaturalSize({
                      src,
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                    event.currentTarget.dataset.loaded = "true";
                    setLoadedSrc(src);
                  }}
                  onError={() => {
                    setDecodeError({
                      src,
                      message: "浏览器无法读取或解码这张图片，请确认路径和文件内容",
                    });
                  }}
                />
              </TransformComponent>
            </TransformWrapper>
          )}
        </div>

        <div
          className="flex min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden"
          data-slot="image-preview-footer"
        >
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-slot="image-preview-meta"
          >
            {metaText}
          </span>
          <div className="grid w-52 shrink-0 grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void downloadImage()}
              disabled={!src || showDecodeError}
              data-slot="image-preview-download"
            >
              <Download aria-hidden="true" />
              下载
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={copyPath}
              disabled={!state.path}
              data-slot="image-preview-copy-path"
            >
              <Copy aria-hidden="true" />
              复制路径
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreviewLoading({ dimmed = false, label }: { dimmed?: boolean; label: string }) {
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
        <span className="text-xs text-muted-foreground">{label}</span>
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

function getImagePreviewMetaText(
  state: ImagePreviewState,
  imageLoaded: boolean,
  showDecodeError: boolean,
): string {
  if (state.status === "loading") return "正在从开发机读取图片...";
  if (state.status !== "ready" || showDecodeError) return " ";
  if (!imageLoaded) return "正在加载图片...";
  if (state.size !== undefined) return `${formatBytes(state.size)} · 图片已加载`;
  return "图片已加载";
}

function getImagePreviewFitScale(
  stageSize: ImagePreviewSize | null,
  naturalSize: ImagePreviewSize | null,
): number {
  if (
    !stageSize ||
    !naturalSize ||
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    naturalSize.width <= 0 ||
    naturalSize.height <= 0
  ) {
    return 1;
  }
  const scale = Math.min(
    1,
    stageSize.width / naturalSize.width,
    stageSize.height / naturalSize.height,
  );
  return Math.max(0.01, Number(scale.toFixed(4)));
}
