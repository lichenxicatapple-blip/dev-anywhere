import { clipboardImagePathMention, getClipboardImageFile } from "./clipboard-image";
import { compressLargeImageForUpload } from "./image-upload-compression";

type ClipboardImageRelay = {
  uploadClipboardImage: (
    sessionId: string,
    file: File,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
};

type ClipboardImageUploadResult = {
  path: string;
  // 已格式化的 "@<path> " 提及文本, 可直接插入 PTY stdin 或 JSON textarea。
  pathMention: string;
};

export async function uploadClipboardImageFromPaste(options: {
  clipboardData: DataTransfer | null;
  relay: ClipboardImageRelay | null;
  sessionId: string;
}): Promise<ClipboardImageUploadResult | null> {
  const file = getClipboardImageFile(options.clipboardData);
  if (!file) return null;
  if (!options.relay) throw new Error("请先连接开发机");

  const uploadFile = await compressLargeImageForUpload(file);
  const response = await options.relay.uploadClipboardImage(options.sessionId, uploadFile);
  if (!response.success || !response.path) {
    throw new Error(response.error ?? "剪贴板图片上传失败");
  }

  return {
    path: response.path,
    pathMention: clipboardImagePathMention(response.path),
  };
}
