import { useEffect, useState } from "react";
import { decodeHeicPreview, isHeicImagePath } from "@/lib/heic-preview";

const IMAGE_ERROR = "浏览器无法读取或解码这张图片，请确认路径和文件内容";

/** Keep native decoding where supported; convert only the preview, never the file. */
export function useImagePreviewSource(source: string, path: string) {
  const [state, setState] = useState<{
    source: string;
    fallback?: boolean;
    url?: string;
    error?: string;
  }>({ source });
  // Reset before children commit so a reopened preview never renders a revoked URL.
  if (state.source !== source) setState({ source });
  const current = state.source === source ? state : { source };
  const fallback = !!source && !!current.fallback;

  useEffect(() => {
    if (!fallback) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void decodeHeicPreview(source, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ source, fallback: true, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          source,
          fallback: true,
          error: error instanceof Error ? error.message : IMAGE_ERROR,
        });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, fallback]);

  return {
    src: fallback ? (current.url ?? "") : source,
    loading: fallback && !current.url && !current.error,
    error: current.error ?? "",
    onError: () => {
      if (!source) return;
      setState((latest) => {
        if (latest.source !== source) return latest;
        if (isHeicImagePath(path) && !latest.fallback) return { source, fallback: true };
        return { ...latest, error: IMAGE_ERROR };
      });
    },
  };
}
