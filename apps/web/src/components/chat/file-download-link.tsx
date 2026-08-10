import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";

interface FileDownloadContextValue {
  download: (path: string, options?: { label?: string }) => void;
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
    (path: string, options?: { label?: string }): void => {
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const displayLabel = options?.label ?? path;
      const toastId = toast.loading(`下载 ${displayLabel} ...`);
      void triggerFileDownload({ relay, sessionId, path }).then((result) => {
        if (result.ok) toast.success(`已开始下载 ${displayLabel}`, { id: toastId });
        else if (options?.label) toast.error(`${displayLabel}下载失败`, { id: toastId });
        else toast.error(result.error, { id: toastId });
      });
    },
    [sessionId],
  );

  const value = useMemo(() => ({ download }), [download]);
  return <FileDownloadContext.Provider value={value}>{children}</FileDownloadContext.Provider>;
}
