// 任意文件 → base64 payload, 与 file_upload_request schema 对齐。size cap 100MB 与 proxy 对齐。
// 大文件 base64 会让消息膨胀 ~33%, 但当前 IPC 链路接受 (proxy 那边 schema 也是 base64 string)。
import type { RelayClient } from "@/services/relay-client";
import { toast } from "@/components/toast";

const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;

export type FileUploadPayload = {
  fileName: string;
  mimeType: string;
  dataBase64: string;
};

export async function fileToUploadPayload(file: File): Promise<FileUploadPayload> {
  if (file.size > MAX_FILE_UPLOAD_BYTES) {
    throw new Error("文件超过 100MB 限制");
  }
  const bytes = await readFileBytes(file);
  return {
    fileName: file.name || "upload",
    mimeType: file.type || "application/octet-stream",
    dataBase64: bytesToBase64(bytes),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

interface UploadFileWithToastOptions {
  relay: RelayClient;
  sessionId: string;
  file: File;
  // 默认 "已上传 {path}"。传 null 不弹成功 toast, 上传中 toast 直接 dismiss
  // (input-bar 用这个 mode: 输入框出现 @<path> 自身就是反馈, 不需要二次成功提示)。
  successLabel?: string | null;
}

// 上传一个文件并管理 toast 生命周期, 共享给 chat-header / use-pty-view drop /
// use-terminal-paste / input-bar 的 picker+drop+paste-fallback 等多个调用点。
// 调用方只决定拿到 path 之后怎么把它写到目标 (PTY stdin / 输入框 draft)。
// 上传失败返回 null, 调用方应直接 return。
export async function uploadFileAndShowToast(
  opts: UploadFileWithToastOptions,
): Promise<string | null> {
  const toastId = toast.loading(`上传 ${opts.file.name} ...`);
  try {
    const payload = await fileToUploadPayload(opts.file);
    const result = await opts.relay.uploadFile(opts.sessionId, payload);
    if (!result.success || !result.path) {
      toast.error(result.error ?? "上传失败", { id: toastId });
      return null;
    }
    if (opts.successLabel === null) {
      toast.dismiss(toastId);
    } else {
      toast.success(opts.successLabel ?? `已上传 ${result.path}`, { id: toastId });
    }
    return result.path;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
    return null;
  }
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("读取文件失败"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("读取文件失败"));
    });
    reader.readAsArrayBuffer(file);
  });
}
