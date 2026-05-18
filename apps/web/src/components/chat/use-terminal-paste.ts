import type { ClipboardEvent, RefObject } from "react";
import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { getClipboardImageFile } from "@/lib/clipboard-image";
import { uploadClipboardImageFromPaste } from "@/lib/clipboard-image-upload";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";

// PTY 视图剪贴板粘贴:
//   - 图片 (任意来源 Finder / 截屏 / 浏览器): 走 image upload, 写入 "@<path> " 提及文本
//   - 其它任意文件: 走通用 file upload, 同样写入 "@<path> " 提及文本
//   - 纯文本 / 无 file: 不拦截, 由 xterm 默认 paste 流程接管 (含 bracketed paste)

interface UseTerminalPasteOptions {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  // 上传完成后调度一次跟随到底部,避免新输入卡在已离屏区域
  onAfterPaste?: () => void;
}

function getFirstNonImageFile(data: DataTransfer | null): File | null {
  if (!data?.files || data.files.length === 0) return null;
  for (const f of data.files) {
    if (!f.type.startsWith("image/")) return f;
  }
  return null;
}

export function useTerminalPaste({
  sessionId,
  terminalRef,
  onAfterPaste,
}: UseTerminalPasteOptions): (event: ClipboardEvent<HTMLDivElement>) => Promise<void> {
  return useCallback(
    async (event: ClipboardEvent<HTMLDivElement>): Promise<void> => {
      const data = event.clipboardData;
      const hasImage = Boolean(getClipboardImageFile(data));
      const otherFile = hasImage ? null : getFirstNonImageFile(data);
      if (!hasImage && !otherFile) return;
      event.preventDefault();
      event.stopPropagation();

      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }

      if (hasImage) {
        const uploadToastId = toast.loading("图片上传中...");
        try {
          const result = await uploadClipboardImageFromPaste({
            clipboardData: data,
            relay,
            sessionId,
          });
          toast.dismiss(uploadToastId);
          if (!result) return;
          sendRemoteInputRaw(sessionId, result.pathMention);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err), { id: uploadToastId });
          return;
        }
      } else if (otherFile) {
        const path = await uploadFileAndShowToast({ relay, sessionId, file: otherFile });
        if (!path) return;
        sendRemoteInputRaw(sessionId, `@${path} `);
      }
      onAfterPaste?.();
      terminalRef.current?.focus();
    },
    [sessionId, terminalRef, onAfterPaste],
  );
}
