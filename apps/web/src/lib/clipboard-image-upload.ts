import {
  clipboardImagePathToken,
  fileToClipboardImagePayload,
  getClipboardImageFile,
  type ClipboardImagePayload,
} from "./clipboard-image";

type ClipboardImageRelay = {
  uploadClipboardImage: (
    sessionId: string,
    payload: ClipboardImagePayload,
  ) => Promise<{ success: boolean; path: string; error?: string }>;
};

type ClipboardImageUploadResult = {
  path: string;
  token: string;
};

export async function uploadClipboardImageFromPaste(options: {
  clipboardData: DataTransfer | null;
  relay: ClipboardImageRelay | null;
  sessionId: string;
}): Promise<ClipboardImageUploadResult | null> {
  const file = getClipboardImageFile(options.clipboardData);
  if (!file) return null;
  if (!options.relay) throw new Error("请先连接开发机");

  const payload = await fileToClipboardImagePayload(file);
  const response = await options.relay.uploadClipboardImage(options.sessionId, payload);
  if (!response.success || !response.path) {
    throw new Error(response.error ?? "剪贴板图片上传失败");
  }

  return {
    path: response.path,
    token: clipboardImagePathToken(response.path),
  };
}
