import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  File,
  FileArchive,
  FileCode2,
  FileText,
  ImageOff,
  LoaderCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserMessageAttachment } from "@/lib/user-message-attachments";
import { useFileDownload } from "./file-download-link";
import { useImagePreview } from "./image-preview";

interface UserMessageAttachmentsProps {
  attachments: UserMessageAttachment[];
}

export function UserMessageAttachments({ attachments }: UserMessageAttachmentsProps) {
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const files = attachments.filter((attachment) => attachment.kind === "file");

  return (
    <div data-slot="user-message-attachments" className="space-y-2">
      {images.length > 0 ? <ImageGallery images={images} /> : null}
      {files.length > 0 ? <FileCards files={files} /> : null}
    </div>
  );
}

function ImageGallery({ images }: { images: UserMessageAttachment[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const overflow = scroller.scrollWidth - scroller.clientWidth > 1;
    setEdges({
      left: overflow && scroller.scrollLeft > 1,
      right: overflow && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    updateEdges();
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [images.length, updateEdges]);

  const multiple = images.length > 1;
  return (
    <div
      data-slot="user-image-gallery"
      data-count={images.length}
      className={cn(
        "relative max-w-full overflow-hidden rounded-lg",
        multiple ? "w-[min(72vw,28rem)]" : "w-[min(64vw,20rem)]",
      )}
      aria-label={`图片附件，共 ${images.length} 张`}
    >
      <div
        ref={scrollerRef}
        data-slot="user-image-gallery-scroller"
        className={cn(
          "flex max-w-full snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-smooth touch-pan-x touch-pan-y",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        onScroll={updateEdges}
      >
        {images.map((image, index) => (
          <RemoteImageCard
            key={`${image.path}-${index}`}
            path={image.path}
            index={index}
            count={images.length}
            multiple={multiple}
            onSettled={updateEdges}
          />
        ))}
      </div>
      <div
        data-slot="user-image-gallery-fade-left"
        data-visible={edges.left ? "true" : "false"}
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-10 w-9 bg-gradient-to-r from-primary to-transparent transition-opacity duration-150",
          edges.left ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
      <div
        data-slot="user-image-gallery-fade-right"
        data-visible={edges.right ? "true" : "false"}
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-primary to-transparent transition-opacity duration-150",
          edges.right ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
    </div>
  );
}

function RemoteImageCard({
  path,
  index,
  count,
  multiple,
  onSettled,
}: {
  path: string;
  index: number;
  count: number;
  multiple: boolean;
  onSettled: () => void;
}) {
  const { openImagePreview, requestImagePreviewUrl } = useImagePreview();
  const [state, setState] = useState<{ url?: string; error?: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    setState({});
    void requestImagePreviewUrl(path)
      .then(({ url }) => {
        if (!cancelled) setState({ url });
      })
      .catch(() => {
        if (!cancelled) setState({ error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [path, requestImagePreviewUrl]);

  const label = count === 1 ? "打开图片" : `打开第 ${index + 1} 张图片`;
  return (
    <button
      type="button"
      data-slot="user-image-attachment"
      className={cn(
        "group relative aspect-[4/3] min-h-28 snap-start overflow-hidden rounded-lg bg-primary-foreground/10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/80 focus-visible:ring-offset-2 focus-visible:ring-offset-primary",
        multiple ? "basis-[78%] shrink-0 sm:basis-48" : "w-full shrink-0",
      )}
      aria-label={label}
      onClick={() => openImagePreview(path)}
    >
      {state.url ? (
        <img
          src={state.url}
          alt=""
          className="size-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.015]"
          draggable={false}
          onLoad={onSettled}
          onError={() => setState({ error: true })}
        />
      ) : state.error ? (
        <span className="flex size-full flex-col items-center justify-center gap-1.5 text-primary-foreground/70">
          <ImageOff className="size-5" aria-hidden="true" />
          <span className="text-xs">无法载入图片</span>
        </span>
      ) : (
        <span className="flex size-full items-center justify-center text-primary-foreground/70">
          <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

function FileCards({ files }: { files: UserMessageAttachment[] }) {
  const { download } = useFileDownload();
  return (
    <div data-slot="user-file-attachments" className="flex max-w-full flex-col gap-1.5">
      {files.map((file, index) => {
        const descriptor = describeFile(file.path);
        const fileName = file.path.split("/").pop() || "文件";
        const Icon = descriptor.icon;
        return (
          <button
            key={`${file.path}-${index}`}
            type="button"
            data-slot="user-file-attachment"
            className={cn(
              "flex min-h-12 w-[min(66vw,18rem)] max-w-full items-center gap-3 rounded-lg bg-primary-foreground/10 px-3 py-2 text-left",
              "transition-colors hover:bg-primary-foreground/15 active:bg-primary-foreground/20",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/80",
            )}
            aria-label={`下载 ${fileName}`}
            onClick={() => download(file.path, { label: descriptor.label })}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground/12">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium leading-tight">{descriptor.label}</span>
              <span className="mt-0.5 block text-[11px] leading-tight text-primary-foreground/70">
                点按下载
              </span>
            </span>
            <Download className="size-4 shrink-0 text-primary-foreground/75" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function describeFile(path: string): {
  label: string;
  icon: typeof File;
} {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(extension)) {
    return { label: "压缩包", icon: FileArchive };
  }
  if (["pdf", "doc", "docx", "pages", "rtf"].includes(extension)) {
    return { label: extension === "pdf" ? "PDF 文件" : "文档附件", icon: FileText };
  }
  if (
    [
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "rs",
      "go",
      "java",
      "kt",
      "swift",
      "c",
      "cc",
      "cpp",
      "h",
      "css",
      "html",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
    ].includes(extension)
  ) {
    return { label: "代码文件", icon: FileCode2 };
  }
  if (["txt", "md", "csv", "log"].includes(extension)) {
    return { label: "文本文件", icon: FileText };
  }
  return { label: "文件附件", icon: File };
}
