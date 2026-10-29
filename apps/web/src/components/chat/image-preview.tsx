import { useEffect, useRef, useState } from "react";
import {
  ClipboardCopy,
  Copy,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  Plus,
  XIcon,
} from "lucide-react";
import {
  TransformComponent,
  TransformWrapper,
  useControls,
  useTransformComponent,
} from "react-zoom-pan-pinch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useImagePreviewSource } from "@/hooks/use-image-preview-source";
import { copyLoadedImageToClipboard } from "@/lib/copy-image";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { cn } from "@/lib/utils";
import { toast } from "@/components/toast";

import type { MediaPreviewState } from "./media-preview";
import { applyImagePreviewTransform } from "./image-preview-transform";

const MAX_IMAGE_SCALE = 8;

type ImagePreviewSize = {
  width: number;
  height: number;
};

type ImagePreviewNaturalSize = ImagePreviewSize & {
  src: string;
};

export function ImagePreviewDialog({
  open,
  onOpenChange,
  sessionId,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  state: MediaPreviewState;
}) {
  const [loadedSrc, setLoadedSrc] = useState("");
  const [stageSize, setStageSize] = useState<ImagePreviewSize | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImagePreviewNaturalSize | null>(null);
  const [copyingImage, setCopyingImage] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const source = open && state.status === "ready" && state.url ? state.url : "";
  const preview = useImagePreviewSource(source, state.path);
  const src = preview.src;
  const imageLoaded = src !== "" && loadedSrc === src;
  const currentNaturalSize = naturalSize?.src === src ? naturalSize : null;
  const fitScale = getImagePreviewFitScale(stageSize, currentNaturalSize);
  const decodeErrorMessage = preview.error;
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

  async function copyImage(): Promise<void> {
    const image = imageRef.current;
    if (!imageLoaded || !image || copyingImage) return;

    setCopyingImage(true);
    const toastId = toast.loading("正在复制图片...");
    const result = await copyLoadedImageToClipboard(image);
    setCopyingImage(false);

    if (result === "copied") {
      toast.success("图片已复制到剪贴板", { id: toastId });
      return;
    }
    if (result === "insecure") {
      toast.error("复制图片需要 HTTPS 安全连接", { id: toastId });
      return;
    }
    if (result === "unsupported") {
      toast.error("当前浏览器不支持复制图片", { id: toastId });
      return;
    }
    if (result === "not-ready") {
      toast.error("图片仍在加载，请稍后重试", { id: toastId });
      return;
    }
    toast.error("复制图片失败，请稍后重试", { id: toastId });
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
        className="dev-image-preview-dialog !top-0 !left-0 grid h-dvh min-w-0 max-h-dvh !max-w-none !translate-x-0 !translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden !rounded-none !border-0 !px-3 !pt-3 !pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:!top-[50%] sm:!left-[50%] sm:h-[min(80dvh,760px)] sm:!w-[min(92vw,72rem)] sm:max-h-[calc(100dvh-2rem)] sm:!max-w-[calc(100vw-2rem)] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!rounded-lg sm:!border sm:!border-border/35 sm:!px-4 sm:!pt-4 sm:!shadow-xl"
        data-slot="image-preview-dialog"
        focusSurfaceOnOpen
        showCloseButton={false}
      >
        <DialogClose
          className="group absolute top-1 right-1 z-30 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="关闭图片预览"
        >
          <span
            className="flex size-7 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-sm ring-1 ring-border/40 backdrop-blur-sm transition-[color,background-color,transform] duration-150 ease-out group-hover:bg-accent group-hover:text-foreground group-active:scale-95 motion-reduce:transition-none"
            data-slot="image-preview-close-visual"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </span>
        </DialogClose>
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
          className="dev-image-preview-stage relative flex min-h-[18rem] w-full min-w-0 max-w-full items-center justify-center overflow-hidden rounded-md border border-border/35 max-sm:min-h-0"
          data-slot="image-preview-stage"
          aria-busy={showLoading}
          ref={stageRef}
        >
          {showLoading && (
            <ImagePreviewLoading dimmed={state.status === "ready"} label={loadingLabel} />
          )}
          {state.status === "error" && <ImagePreviewError error={state.error ?? "图片预览失败"} />}
          {showDecodeError && <ImagePreviewError error={decodeErrorMessage} />}
          {state.status === "ready" && src && !showDecodeError && (
            // wheel / pinch / drag 一起承担缩放 + 平移; doubleClick reset 回 fit。
            // 初始 scale 按图片自然尺寸和 stage 尺寸计算，避免移动端宽图以 1:1
            // 内容尺寸进入 transform 后被裁切且无法横向移动。
            <TransformWrapper
              key={transformKey}
              initialScale={fitScale}
              minScale={fitScale}
              maxScale={MAX_IMAGE_SCALE}
              centerOnInit
              centerZoomedOut
              limitToBounds
              wheel={{ step: 0.15 }}
              pinch={{ step: 5 }}
              doubleClick={{ mode: "reset" }}
            >
              <TransformComponent
                wrapperClass="!h-full !w-full cursor-grab active:cursor-grabbing"
                contentClass="flex items-center justify-center"
                contentStyle={imageContentStyle}
              >
                <img
                  ref={imageRef}
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
                  onError={preview.onError}
                />
              </TransformComponent>
              {imageLoaded && <ImagePreviewZoomControls minScale={fitScale} />}
            </TransformWrapper>
          )}
        </div>

        <div
          className="flex min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden"
          data-slot="image-preview-footer"
        >
          <span
            className="min-w-0 truncate text-xs text-muted-foreground max-sm:sr-only"
            data-slot="image-preview-meta"
          >
            {metaText}
          </span>
          <div className="grid w-full shrink-0 grid-cols-3 gap-2 sm:w-80">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void downloadImage()}
              disabled={!source}
              data-slot="image-preview-download"
            >
              <Download aria-hidden="true" />
              下载
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void copyImage()}
              disabled={!imageLoaded || showDecodeError || copyingImage}
              data-slot="image-preview-copy-image"
            >
              {copyingImage ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <ClipboardCopy aria-hidden="true" />
              )}
              {copyingImage ? "复制中" : "复制图片"}
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

function ImagePreviewZoomControls({ minScale }: { minScale: number }) {
  const transform = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  const zoom = (direction: "in" | "out") => {
    const wrapper = transform.instance.wrapperComponent;
    if (!wrapper) return;
    const { scale: currentScale, positionX, positionY } = transform.state;
    const nextScale = Math.min(
      MAX_IMAGE_SCALE,
      Math.max(minScale, currentScale * Math.exp(direction === "in" ? 0.35 : -0.35)),
    );
    const centerX = wrapper.offsetWidth / 2;
    const centerY = wrapper.offsetHeight / 2;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160;
    applyImagePreviewTransform(
      transform,
      centerX - ((centerX - positionX) * nextScale) / currentScale,
      centerY - ((centerY - positionY) * nextScale) / currentScale,
      nextScale,
      duration,
    );
  };

  return (
    <div
      className="absolute right-3 bottom-3 z-20 flex items-center gap-0.5 rounded-full border border-border/40 bg-background/75 p-0.5 shadow-sm backdrop-blur-md"
      data-slot="image-preview-zoom-controls"
      role="group"
      aria-label="图片缩放"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        aria-label="缩小图片"
        title="缩小图片"
        disabled={scale <= minScale + 0.0001}
        onClick={() => zoom("out")}
      >
        <Minus className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        aria-label="放大图片"
        title="放大图片"
        disabled={scale >= MAX_IMAGE_SCALE}
        onClick={() => zoom("in")}
      >
        <Plus className="size-4" aria-hidden="true" />
      </Button>
    </div>
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
  state: MediaPreviewState,
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
