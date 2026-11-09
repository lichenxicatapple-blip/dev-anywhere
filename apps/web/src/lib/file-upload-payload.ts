import type { RelayClient } from "@/services/relay-client";
import { toast } from "@/components/toast";
import {
  compressLargeImageForUpload,
  shouldCompressImageForUpload,
} from "./image-upload-compression";

const CLIPBOARD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

interface UploadFilesWithToastOptions {
  relay: RelayClient;
  sessionId: string;
  files: readonly File[];
  clipboard?: boolean;
  successLabel?: string | null;
  onUploaded?: (file: File, path: string) => void;
}

/** Upload sequentially so compression stays bounded and attachments keep their selected order. */
export async function uploadFilesAndShowToast(
  opts: UploadFilesWithToastOptions,
): Promise<Array<{ file: File; path: string }>> {
  const files = Array.from(opts.files);
  if (files.length === 0) return [];

  const uploaded: Array<{ file: File; path: string }> = [];
  const failures: string[] = [];
  let toastId: string | number | undefined;
  for (const [index, file] of files.entries()) {
    const progress = `(${index + 1}/${files.length})`;
    const action = shouldCompressImageForUpload(file) ? "正在压缩并上传" : "正在上传";
    const label = `${action} ${file.name} ${progress}`;
    toastId = index === 0 ? toast.loading(label) : toast.loading(label, { id: toastId });
    try {
      const prepared = await compressLargeImageForUpload(file);
      const result =
        opts.clipboard && CLIPBOARD_IMAGE_TYPES.has(file.type)
          ? await opts.relay.uploadClipboardImage(opts.sessionId, prepared)
          : await opts.relay.uploadFile(opts.sessionId, prepared);
      if (!result.success || !result.path) {
        failures.push(`${file.name}：${result.error || "上传失败"}`);
        continue;
      }
      uploaded.push({ file, path: result.path });
      try {
        opts.onUploaded?.(file, result.path);
      } catch (error) {
        failures.push(
          `${file.name}：已上传，但无法添加附件（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    } catch (error) {
      failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    toast.error(`已上传 ${uploaded.length}/${files.length} 个文件`, {
      id: toastId,
      description: failures.join("\n"),
    });
  } else if (opts.successLabel === null) {
    toast.dismiss(toastId);
  } else {
    toast.success(
      opts.successLabel ??
        (files.length === 1 ? `已上传 ${uploaded[0]!.path}` : `已上传 ${uploaded.length} 个文件`),
      { id: toastId },
    );
  }
  return uploaded;
}
