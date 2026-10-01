import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { describeControlError } from "@/lib/control-error-message";
import { getMediaPreviewKind } from "@/lib/media-preview-path";
import { ImagePreviewDialog } from "./image-preview";
import { VideoPreviewDialog } from "./video-preview";

export type MediaPreviewState = {
  status: "loading" | "ready" | "error";
  path: string;
  url?: string;
  size?: number;
  error?: string;
};

type PreviewUrl = { url: string; path: string };
type MediaPreviewContextValue = {
  openMediaPreview: (path: string) => void;
  requestMediaPreviewUrl: (path: string) => Promise<PreviewUrl>;
};
type PreviewUrlCacheEntry = {
  sessionId: string;
  expiresAt: number;
  request: Promise<PreviewUrl>;
};

const MediaPreviewContext = createContext<MediaPreviewContextValue | null>(null);
const NOOP_MEDIA_PREVIEW_CONTEXT: MediaPreviewContextValue = {
  openMediaPreview: () => undefined,
  requestMediaPreviewUrl: () => Promise.reject(new Error("文件预览不可用")),
};

export function useMediaPreview(): MediaPreviewContextValue {
  return useContext(MediaPreviewContext) ?? NOOP_MEDIA_PREVIEW_CONTEXT;
}

export function MediaPreviewProvider({
  sessionId,
  active = true,
  children,
}: {
  sessionId: string;
  active?: boolean;
  children: ReactNode;
}) {
  const [preview, setPreview] = useState<{
    sessionId: string;
    kind: "image" | "video";
    state: MediaPreviewState;
  } | null>(null);
  const requestSeqRef = useRef(0);
  const activeRef = useRef(active);
  const previewUrlCacheRef = useRef(new Map<string, PreviewUrlCacheEntry>());

  const requestMediaPreviewUrl = useCallback(
    (path: string): Promise<PreviewUrl> => {
      const cached = previewUrlCacheRef.current.get(path);
      if (cached?.sessionId === sessionId && cached.expiresAt > Date.now()) return cached.request;
      const relay = relayClientRef;
      if (!relay) return Promise.reject(new Error("请先连接开发机"));
      const entry: PreviewUrlCacheEntry = {
        sessionId,
        expiresAt: Infinity,
        request: relay.requestRemoteFileUrl(sessionId, path, "inline").then((result) => {
          if (!result.success || !result.url) {
            throw new Error(
              describeControlError({
                errorCode: result.errorCode,
                rawError: result.error,
                fallback: "文件预览失败",
              }),
            );
          }
          entry.expiresAt = result.expiresAt ?? Date.now() + 60_000;
          return { url: result.url, path: result.path || path };
        }),
      };
      entry.request = entry.request.catch((error: unknown) => {
        if (previewUrlCacheRef.current.get(path) === entry) previewUrlCacheRef.current.delete(path);
        throw error;
      });
      previewUrlCacheRef.current.set(path, entry);
      return entry.request;
    },
    [sessionId],
  );

  const closePreview = useCallback(() => {
    requestSeqRef.current += 1;
    setPreview(null);
  }, []);

  const openMediaPreview = useCallback(
    (path: string) => {
      const kind = getMediaPreviewKind(path);
      if (!activeRef.current || !kind) return;
      const requestSeq = ++requestSeqRef.current;
      // A Shell may have changed cwd since the last preview of this relative path.
      // Explicit opens resolve it again; thumbnails can still share cached requests.
      previewUrlCacheRef.current.delete(path);
      setPreview({ sessionId, kind, state: { status: "loading", path } });
      void requestMediaPreviewUrl(path)
        .then((result) => {
          if (requestSeqRef.current !== requestSeq) return;
          setPreview({ sessionId, kind, state: { status: "ready", ...result } });
        })
        .catch((error: unknown) => {
          if (requestSeqRef.current !== requestSeq) return;
          setPreview({
            sessionId,
            kind,
            state: {
              status: "error",
              path,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
    },
    [sessionId, requestMediaPreviewUrl],
  );

  useEffect(() => {
    closePreview();
    previewUrlCacheRef.current.clear();
    return () => {
      requestSeqRef.current += 1;
    };
  }, [sessionId, closePreview]);

  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active) closePreview();
  }, [active, closePreview]);

  const value = useMemo(
    () => ({ openMediaPreview, requestMediaPreviewUrl }),
    [openMediaPreview, requestMediaPreviewUrl],
  );
  const visible = active && preview?.sessionId === sessionId ? preview : null;
  return (
    <MediaPreviewContext.Provider value={value}>
      {children}
      {visible?.kind === "image" && (
        <ImagePreviewDialog
          open
          onOpenChange={closePreview}
          sessionId={sessionId}
          state={visible.state}
        />
      )}
      {visible?.kind === "video" && (
        <VideoPreviewDialog
          state={visible.state}
          sessionId={sessionId}
          onClose={closePreview}
          onRetry={() => {
            // A loaded preview belongs to the resolved file even if the Shell later cd's.
            openMediaPreview(visible.state.path);
          }}
        />
      )}
    </MediaPreviewContext.Provider>
  );
}
