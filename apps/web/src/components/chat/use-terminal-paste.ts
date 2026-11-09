import type { ClipboardEvent, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { clipboardImagePathMention, getClipboardFiles } from "@/lib/clipboard-image";
import { uploadFilesAndShowToast } from "@/lib/file-upload-payload";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";

// PTY 视图剪贴板粘贴:
//   - 图片和文件: 按剪贴板顺序上传, 一次写入所有成功的 "@<path> " 提及文本
//   - 纯文本 / 无 file: 不拦截, 由 xterm 默认 paste 流程接管 (含 bracketed paste)

interface UseTerminalPasteOptions {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  // 上传完成后调度一次跟随到底部,避免新输入卡在已离屏区域
  onAfterPaste?: () => void;
}

export function useTerminalPaste({
  sessionId,
  terminalRef,
  onAfterPaste,
}: UseTerminalPasteOptions): (event: ClipboardEvent<HTMLDivElement>) => Promise<void> {
  const activeTargetRef = useRef<UseTerminalPasteOptions | null>(null);
  useLayoutEffect(() => {
    activeTargetRef.current = { sessionId, terminalRef, onAfterPaste };
    return () => {
      activeTargetRef.current = null;
    };
  }, [sessionId, terminalRef, onAfterPaste]);

  return useCallback(
    async (event: ClipboardEvent<HTMLDivElement>): Promise<void> => {
      const files = getClipboardFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();

      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }

      const terminal = terminalRef.current;
      const uploaded = await uploadFilesAndShowToast({ relay, sessionId, files, clipboard: true });
      if (uploaded.length === 0) return;
      sendRemoteInputRaw(
        sessionId,
        uploaded.map(({ path }) => clipboardImagePathMention(path)).join(""),
      );

      // 文件仍写入发起粘贴的会话, 但切换会话或重建终端后不能抢焦点/滚动新画面。
      const activeTarget = activeTargetRef.current;
      if (
        terminal &&
        activeTarget?.sessionId === sessionId &&
        activeTarget.terminalRef.current === terminal
      ) {
        activeTarget.onAfterPaste?.();
        terminal.focus();
      }
    },
    [sessionId, terminalRef],
  );
}
