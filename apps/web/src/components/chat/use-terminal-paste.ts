import type { ClipboardEvent, RefObject } from "react";
import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { getClipboardImageFile } from "@/lib/clipboard-image";
import { uploadClipboardImageFromPaste } from "@/lib/clipboard-image-upload";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";

// PTY 视图剪贴板粘贴：图片走 uploadClipboardImageFromPaste 上传 + 发回 token；
// 文本/其它内容不拦截，由 xterm 默认 paste 流程处理。

interface UseTerminalPasteOptions {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  // 上传完成后调度一次跟随到底部，避免新输入卡在已离屏区域
  onAfterPaste?: () => void;
}

export function useTerminalPaste({
  sessionId,
  terminalRef,
  onAfterPaste,
}: UseTerminalPasteOptions): (event: ClipboardEvent<HTMLDivElement>) => Promise<void> {
  return useCallback(
    async (event: ClipboardEvent<HTMLDivElement>): Promise<void> => {
      if (!getClipboardImageFile(event.clipboardData)) return;
      event.preventDefault();
      event.stopPropagation();

      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }

      try {
        const result = await uploadClipboardImageFromPaste({
          clipboardData: event.clipboardData,
          relay,
          sessionId,
        });
        if (!result) return;
        sendRemoteInputRaw(sessionId, result.token);
        onAfterPaste?.();
        terminalRef.current?.focus();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, terminalRef, onAfterPaste],
  );
}
