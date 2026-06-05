import type { RelayClient } from "@/services/relay-client";
import { toast } from "@/components/toast";

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
    const result = await opts.relay.uploadFile(opts.sessionId, opts.file);
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
