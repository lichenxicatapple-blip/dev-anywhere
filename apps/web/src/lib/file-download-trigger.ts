// 触发浏览器把开发机的文件下载到用户本地。沿用 image-preview 的 base64 → data URL 路径,
// 创建临时 <a download> 自点击。Safari 对 data URL 直接 download 受限的场景这里用 blob URL
// 兜底, blob URL 无大小限制且 Safari 兼容。

import type { RelayClient } from "@/services/relay-client";

type DownloadOpts = {
  relay: RelayClient;
  sessionId: string;
  path: string;
};

type DownloadResult =
  | { ok: true; size: number }
  | { ok: false; error: string };

export async function triggerFileDownload(opts: DownloadOpts): Promise<DownloadResult> {
  const resp = await opts.relay.requestFileDownload(opts.sessionId, opts.path);
  if (!resp.success || !resp.dataBase64 || !resp.mimeType) {
    return { ok: false, error: resp.error ?? "下载失败" };
  }
  const blob = base64ToBlob(resp.dataBase64, resp.mimeType);
  const blobUrl = URL.createObjectURL(blob);
  try {
    const fileName = opts.path.split(/[\\/]/).pop() || "download";
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // 给浏览器一帧时间发起下载, 再回收 blob URL
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
  return { ok: true, size: resp.size ?? blob.size };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
