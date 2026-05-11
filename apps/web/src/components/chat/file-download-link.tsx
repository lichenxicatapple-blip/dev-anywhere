// JSON 消息气泡里的文件下载快捷入口, 与 image-preview.tsx 的 ImagePreviewLinks 形状对称。
// extractFileDownloadPaths 已在路径解析层排除图片扩展, 因此图片走 ImagePreviewLinks,
// 其它文件走 FileDownloadLinks, 同一段文本里两者不会重复渲染同一路径。
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Download } from "lucide-react";
import { extractFileDownloadPaths } from "@/lib/file-download-path";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";

interface FileDownloadContextValue {
  download: (path: string) => void;
}

const FileDownloadContext = createContext<FileDownloadContextValue | null>(null);

export function useFileDownload(): FileDownloadContextValue {
  return useContext(FileDownloadContext) ?? { download: () => undefined };
}

export function FileDownloadProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const download = useCallback(
    (path: string): void => {
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const toastId = toast.loading(`下载 ${path} ...`);
      void triggerFileDownload({ relay, sessionId, path }).then((result) => {
        if (result.ok) toast.success(`已下载 ${path}`, { id: toastId });
        else toast.error(result.error, { id: toastId });
      });
    },
    [sessionId],
  );

  const value = useMemo(() => ({ download }), [download]);
  return <FileDownloadContext.Provider value={value}>{children}</FileDownloadContext.Provider>;
}

export function FileDownloadLinks({
  text,
  tone = "default",
}: {
  text: string;
  tone?: "default" | "on-primary";
}) {
  const paths = extractFileDownloadPaths(text);
  const { download } = useFileDownload();
  if (paths.length === 0) return null;

  return (
    <div className="not-prose mt-2 flex flex-wrap gap-1.5" data-slot="file-download-links">
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
          data-slot="file-download-link"
          onClick={() => download(path)}
        >
          <Download aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{path}</span>
        </button>
      ))}
    </div>
  );
}
