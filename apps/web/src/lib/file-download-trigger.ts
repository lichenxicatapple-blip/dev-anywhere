// 触发浏览器把开发机的文件下载到用户本地。文件内容走 relay HTTP streaming，
// 前端只申请一次性 URL，不把文件读进 JS 内存。

import type { RelayClient } from "@/services/relay-client";
import { describeControlError } from "./control-error-message";
import { requestRemoteFileUrlWithFallback } from "./remote-file-url";

type DownloadOpts = {
  relay: RelayClient;
  sessionId: string;
  path: string;
  fallbackPath?: string;
};

type DownloadResult = { ok: true; path: string } | { ok: false; error: string };

export async function triggerFileDownload(opts: DownloadOpts): Promise<DownloadResult> {
  const startedAt = Date.now();
  const { path, response: resp } = await requestRemoteFileUrlWithFallback(
    opts.relay,
    opts.sessionId,
    opts.path,
    "download",
    opts.fallbackPath,
  );
  if (!resp.success || !resp.url) {
    const reason = describeControlError({
      errorCode: resp.errorCode,
      rawError: resp.error,
      fallback: "下载失败",
    });
    const errorMessage = describeFileDownloadFailure(path, reason);
    console.debug("[file-download] failed", {
      sessionId: opts.sessionId,
      path,
      durationMs: Date.now() - startedAt,
      errorCode: resp.errorCode,
      errorMessage,
      rawError: resp.error,
    });
    return { ok: false, error: errorMessage };
  }
  const fileName = path.split(/[\\/]/).pop() || "download";
  const a = document.createElement("a");
  a.href = resp.url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  console.debug("[file-download] ok", {
    sessionId: opts.sessionId,
    path,
    fileName,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true, path };
}

function describeFileDownloadFailure(path: string, reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed === "下载失败") return `下载失败：${path}`;
  return `下载失败：${path}（${trimmed}）`;
}
