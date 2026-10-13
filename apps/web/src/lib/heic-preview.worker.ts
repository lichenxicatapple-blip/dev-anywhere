import { heicTo } from "heic-to/next";

// This module is loaded only after native image decoding fails for HEIC/HEIF.
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const blob = await heicTo({ blob: event.data, type: "image/png" });
    self.postMessage({ blob });
  } catch {
    self.postMessage({ error: "无法解码这张 HEIC 图片，请下载原文件查看" });
  }
};
