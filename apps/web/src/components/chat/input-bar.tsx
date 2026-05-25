// InputBar: JSON 消息输入栏, 1-8 行自撑, 斜杠/@/iOS 键盘适配
// PTY 模式由 xterm 逐键输入承载，不再复用聊天式 InputBar。
// draft 为 per-session, 通过 chat-store 跨组件共享
// 命令 (/cmd) / @<路径> 这类原子片段整体删除: insertedMentions 记录所有选过的片段,
// onChange 拦 backspace 跨片段清理
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { ImageIcon, Paperclip, Upload } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import { isCompactCommandText, type CommandEntry } from "@dev-anywhere/shared";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { useAppStore } from "@/stores/app-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cleanupDeletedMention, computeSendDisabled, detectPickerMode } from "./input-bar-utils";
import { SlashCommandPicker } from "./slash-command-picker";
import { FilePathPicker } from "./file-path-picker";
import { SendButton } from "./send-button";
import type { PickerHandle } from "./picker-handle";
import { getEffectiveChatContentFontSize } from "@/lib/chat-font-size";
import { getClipboardImageFile, insertTextAtSelection } from "@/lib/clipboard-image";
import { uploadClipboardImageFromPaste } from "@/lib/clipboard-image-upload";
import { showCompactStartToast } from "@/lib/compact-toast";
import { toast } from "@/components/toast";

interface InputBarProps {
  sessionId: string;
}

export function InputBar({ sessionId }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashPickerRef = useRef<PickerHandle>(null);
  const filePickerRef = useRef<PickerHandle>(null);
  const slice = useChatStore((s) => s.bySessionId[sessionId] ?? EMPTY_SLICE);
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const chatContentFontSize = useAppStore((s) => s.chatContentFontSize);
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const effectiveChatContentFontSize = getEffectiveChatContentFontSize(
    chatContentFontSize,
    touchEditingSurface,
  );
  // 发送按钮的 working 态直接读 session.state（proxy 推的单一权威信号）
  const sessionState = useSessionStore(
    (s) => s.sessions.find((x) => x.sessionId === sessionId)?.state,
  );
  const updateSessionState = useSessionStore((s) => s.updateSessionState);
  // 桌面 placeholder 带物理键盘快捷键提示, 手机软键盘上没 Shift / 方向键, 且 320px 会折两行
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const submitOnPlainEnter = isDesktop && !touchEditingSurface;

  const value = slice.inputDraft;
  const isWorking = sessionState === "working";
  const isBusy = isWorking || sessionState === "compacting";
  const pendingApprovals = slice.pendingApprovals;

  const pickerMode = detectPickerMode(value);
  const sendDisabled = computeSendDisabled(isBusy, pendingApprovals);
  const canSend = !sendDisabled && value.trim() !== "";

  // 已插入的原子片段 (slash 命令 / @<路径>), 用于 backspace 整体删除
  const [insertedMentions, setInsertedMentions] = useState<string[]>([]);
  const [clipboardImageUploading, setClipboardImageUploading] = useState(false);
  // 选中 slash 命令后的参数提示 (argumentHint), 显示在输入栏上方
  const [argumentHint, setArgumentHint] = useState("");
  // 记录上次的 value, 用于 onChange 对比推断删除方向
  const prevTextRef = useRef(value);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  // 会话切换时重置 mention 跟踪 (argumentHint 随之失效, insertedMentions 作废)
  useEffect(() => {
    setInsertedMentions([]);
    setArgumentHint("");
  }, [sessionId]);

  // value 变化时保持 prevTextRef 同步: 覆盖外部触发的 draft 更新
  // picker onSelect 内部已手动同步, 这里是兜底。
  useEffect(() => {
    prevTextRef.current = value;
  }, [value]);

  const clearTrackingState = useCallback(() => {
    setInsertedMentions([]);
    setArgumentHint("");
  }, []);

  const applyInputDraft = useCallback(
    (nextValue: string) => {
      setInputDraft(sessionId, nextValue);
      prevTextRef.current = nextValue;
    },
    [sessionId, setInputDraft],
  );

  const send = useCallback(() => {
    // 统一闸门: Enter 快捷键曾绕开 canSend 直调 send, working 中按 Enter 仍会发出
    // 放这里所有入口 (form submit / Enter / SendButton 点击) 都受保护
    if (!canSend) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const relay = relayClientRef;
    if (!relay) return;
    const now = Date.now();
    const messageId = `${sessionId}-user-${now}`;
    const isCompactCommand = isCompactCommandText(trimmed);
    if (!isCompactCommand) {
      // 乐观入 store: 立即显示 user bubble + working 态, echo 回来时 dispatcher 不重复追加
      addUserMessage(sessionId, {
        id: messageId,
        role: "user",
        text: trimmed,
        isPartial: false,
        timestamp: now,
        toolCalls: [],
      });
    }
    // 乐观翻 session.state：proxy 20~50ms 内会回 session_status 覆写（包括万一没被接受的降级态）
    updateSessionState(sessionId, isCompactCommand ? "compacting" : "working", now);
    if (isCompactCommand) showCompactStartToast(sessionId);
    relay.sendEnvelope({
      type: "user_input",
      sessionId,
      payload: { text: trimmed, messageId },
      seq: 0,
      timestamp: now,
      source: "client",
      version: "1",
    });
    applyInputDraft("");
    clearTrackingState();
  }, [
    canSend,
    value,
    sessionId,
    addUserMessage,
    updateSessionState,
    applyInputDraft,
    clearTrackingState,
  ]);

  // onChange 拦截: backspace 删到原子片段时整体清除, 维护 insertedMentions
  const handleValueChange = (nextVal: string) => {
    const prev = prevTextRef.current;
    const { cleaned, removedMention } = cleanupDeletedMention(nextVal, prev, insertedMentions);
    if (removedMention) {
      setInsertedMentions((mentions) => mentions.filter((m) => m !== removedMention));
      // 删掉的是 slash 命令 (以 "/" 开头), 参数提示也同步清空
      if (removedMention.startsWith("/")) setArgumentHint("");
      applyInputDraft(cleaned);
      return;
    }
    applyInputDraft(nextVal);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // picker 打开时优先把 ↑↓/Enter 转给 picker, 未消费再走默认流程
    if (pickerMode !== "none") {
      const picker = pickerMode === "slash" ? slashPickerRef.current : filePickerRef.current;
      if (picker?.handleKey(e)) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // IME 组合输入中 (中日韩输入法候选栏), Enter 语义是"确认候选", 让输入法消化
      // 不拦截, 也不 preventDefault, 避免把候选残留在 textarea 里同时又发送
      if (e.nativeEvent.isComposing) return;
      if (pickerMode === "none" && submitOnPlainEnter) {
        e.preventDefault();
        send();
      }
    } else if (e.key === "Escape") {
      if (pickerMode !== "none") {
        e.preventDefault();
        const cleaned = value.replace(/\/\S*$/, "").replace(/@\S*$/, "");
        applyInputDraft(cleaned);
      }
    }
  };

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData;
      const hasImage = Boolean(getClipboardImageFile(data));
      const otherFile = hasImage
        ? null
        : (() => {
            if (!data.files || data.files.length === 0) return null;
            for (const f of data.files) {
              if (!f.type.startsWith("image/")) return f;
            }
            return null;
          })();
      if (!hasImage && !otherFile) return;
      event.preventDefault();

      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }

      const pasteSessionId = sessionId;
      setClipboardImageUploading(true);
      try {
        // pathMention: 上传成功后插入到输入框的 "@<path> " 文本片段
        let pathMention: string | null = null;
        if (hasImage) {
          const uploadToastId = toast.loading("图片上传中...");
          try {
            const result = await uploadClipboardImageFromPaste({
              clipboardData: data,
              relay,
              sessionId: pasteSessionId,
            });
            toast.dismiss(uploadToastId);
            if (!result) return;
            pathMention = result.pathMention;
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err), { id: uploadToastId });
            return;
          }
        } else if (otherFile) {
          const path = await uploadFileAndShowToast({
            relay,
            sessionId: pasteSessionId,
            file: otherFile,
            successLabel: null,
          });
          if (!path) return;
          pathMention = `@${path} `;
        }
        if (!pathMention) return;

        const activeTextarea =
          currentSessionIdRef.current === pasteSessionId ? textareaRef.current : null;
        const currentValue =
          activeTextarea?.value ??
          useChatStore.getState().bySessionId[pasteSessionId]?.inputDraft ??
          "";
        const selectionStart = activeTextarea?.selectionStart ?? currentValue.length;
        const selectionEnd = activeTextarea?.selectionEnd ?? currentValue.length;
        const next = insertTextAtSelection(currentValue, pathMention, selectionStart, selectionEnd);
        if (activeTextarea) {
          applyInputDraft(next.value);
          setInsertedMentions((mentions) => [...mentions, pathMention.trim()]);
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
          });
        } else {
          setInputDraft(pasteSessionId, next.value);
        }
      } finally {
        setClipboardImageUploading(false);
      }
    },
    [applyInputDraft, sessionId, setInputDraft],
  );

  // 任意文件上传: picker (Paperclip 按钮) 和 drag-drop 共用同一上传逻辑。
  // 走 file-upload-payload → relay.uploadFile, 成功后把 @<path> 插入当前光标位置, 复用
  // image paste 的 insertTextAtSelection / insertedMentions 跟踪逻辑。
  // 图片 / 文件分两个 input: Android Chrome (vivo 等 OEM 定制) 在点击没设 accept 的
  // file input 时会预申请相机权限。拆开后"上传文件"路径用排除 image/video 的 accept,
  // 不再触发相机授权弹窗; "上传图片" 路径明确想选图, 即使弹相机也符合预期。
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const uploadAndInsertFile = useCallback(
    async (file: File): Promise<void> => {
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const uploadSessionId = sessionId;
      setClipboardImageUploading(true);
      try {
        const path = await uploadFileAndShowToast({
          relay,
          sessionId: uploadSessionId,
          file,
          // 路径会作为 @<path> 出现在输入框, 不再额外弹成功 toast 打扰
          successLabel: null,
        });
        if (!path) return;
        const pathMention = `@${path} `;
        const activeTextarea =
          currentSessionIdRef.current === uploadSessionId ? textareaRef.current : null;
        const currentValue =
          activeTextarea?.value ??
          useChatStore.getState().bySessionId[uploadSessionId]?.inputDraft ??
          "";
        const selectionStart = activeTextarea?.selectionStart ?? currentValue.length;
        const selectionEnd = activeTextarea?.selectionEnd ?? currentValue.length;
        const next = insertTextAtSelection(currentValue, pathMention, selectionStart, selectionEnd);
        if (activeTextarea) {
          applyInputDraft(next.value);
          setInsertedMentions((mentions) => [...mentions, pathMention.trim()]);
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
          });
        } else {
          setInputDraft(uploadSessionId, next.value);
        }
      } finally {
        setClipboardImageUploading(false);
      }
    },
    [applyInputDraft, sessionId, setInputDraft],
  );

  const handleFilePicked = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await uploadAndInsertFile(file);
    },
    [uploadAndInsertFile],
  );

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLFormElement>): Promise<void> => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      setIsDragOver(false);
      await uploadAndInsertFile(file);
    },
    [uploadAndInsertFile],
  );

  const placeholder = submitOnPlainEnter
    ? "输入消息... (Enter 发送，Shift+Enter 换行)"
    : "输入消息...";

  return (
    <div className="relative w-full" data-slot="input-bar" data-mode="json">
      {pickerMode === "slash" && (
        <SlashCommandPicker
          ref={slashPickerRef}
          filter={value.slice(value.lastIndexOf("/"))}
          onSelect={(cmd: CommandEntry) => {
            // cmd.name 已含前导 "/", 别再拼 `/${name}` 否则出现 //clear
            const slashCommand = cmd.name;
            const newVal = value.replace(/\/[^\s]*$/, `${slashCommand} `);
            applyInputDraft(newVal);
            setInsertedMentions((prev) => [...prev, slashCommand]);
            setArgumentHint(cmd.argumentHint ?? "");
            textareaRef.current?.focus();
          }}
        />
      )}
      {pickerMode === "file" && (
        <FilePathPicker
          ref={filePickerRef}
          mode="insert"
          filter={value.slice(value.lastIndexOf("@"))}
          onSelect={(path) => {
            // 目录以 "/" 结尾: 不加空格, 让 picker 保持打开继续挑下一级
            // 文件: 加空格关闭 picker, 并把最终 mention 记入 insertedMentions 用于整片段退格
            const isDir = path.endsWith("/");
            const pathMention = `@${path}`;
            const newVal = value.replace(/@[^\s]*$/, isDir ? pathMention : `${pathMention} `);
            applyInputDraft(newVal);
            if (!isDir) setInsertedMentions((prev) => [...prev, pathMention]);
            textareaRef.current?.focus();
          }}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!isDragOver) setIsDragOver(true);
        }}
        onDragLeave={(event) => {
          // 只在真正离开 form (不是子元素冒泡) 才清; relatedTarget 在 form 之外才算离开
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setIsDragOver(false);
        }}
        onDrop={(event) => {
          void handleDrop(event);
        }}
        data-slot="input-card"
        data-drag-over={isDragOver ? "true" : undefined}
        className="flex flex-col w-full rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 data-[drag-over=true]:border-primary data-[drag-over=true]:ring-[3px] data-[drag-over=true]:ring-primary/50 dark:bg-input/30"
      >
        {argumentHint && (
          <div
            className="px-3 pt-1.5 text-[11px] text-muted-foreground font-mono truncate"
            data-slot="input-argument-hint"
          >
            参数: {argumentHint}
          </div>
        )}
        <div className="flex items-center w-full">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleValueChange(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={onKeyDown}
            enterKeyHint={submitOnPlainEnter ? "send" : "enter"}
            placeholder={placeholder}
            className="flex-1 resize-none rounded-none border-0 bg-transparent font-normal shadow-none max-h-60 min-h-11 focus-visible:border-0 focus-visible:ring-0 md:min-h-0 dark:bg-transparent"
            style={{ fontSize: effectiveChatContentFontSize }}
            rows={1}
            aria-label="输入聊天消息"
            aria-busy={clipboardImageUploading}
          />
          <div className="self-stretch relative flex items-center p-1.5 gap-1 before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
            <AttachMenu
              open={attachOpen}
              onOpenChange={setAttachOpen}
              isDesktop={isDesktop}
              onPickImage={() => {
                setAttachOpen(false);
                imageInputRef.current?.click();
              }}
              onPickFile={() => {
                setAttachOpen(false);
                fileInputRef.current?.click();
              }}
            />
            <SendButton
              sessionId={sessionId}
              isWorking={isWorking}
              canSend={canSend}
              onSend={send}
            />
          </div>
        </div>
      </form>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-slot="input-attach-image-input"
        onChange={(event) => {
          void handleFilePicked(event);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/*,text/*"
        className="hidden"
        data-slot="input-attach-file-input"
        onChange={(event) => {
          void handleFilePicked(event);
        }}
      />
    </div>
  );
}

interface AttachMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktop: boolean;
  onPickImage: () => void;
  onPickFile: () => void;
}

function AttachMenu({ open, onOpenChange, isDesktop, onPickImage, onPickFile }: AttachMenuProps) {
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 md:size-9"
      aria-label="附加"
      data-slot="input-attach-button"
    >
      <Paperclip aria-hidden="true" />
    </Button>
  );

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <AttachMenuItems variant="popover" onPickImage={onPickImage} onPickFile={onPickFile} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-auto gap-0 rounded-t-xl bg-popover pt-2 pb-[max(theme(spacing.2),env(safe-area-inset-bottom))] border-t-0"
      >
        <VisuallyHidden.Root>
          <SheetTitle>附加内容</SheetTitle>
        </VisuallyHidden.Root>
        <div
          aria-hidden="true"
          className="mx-auto mb-1 h-1 w-10 rounded-full bg-border"
          data-slot="sheet-drag-handle"
        />
        <AttachMenuItems variant="sheet" onPickImage={onPickImage} onPickFile={onPickFile} />
      </SheetContent>
    </Sheet>
  );
}

function AttachMenuItems({
  variant,
  onPickImage,
  onPickFile,
}: {
  variant: "popover" | "sheet";
  onPickImage: () => void;
  onPickFile: () => void;
}) {
  const itemH = variant === "sheet" ? "h-12" : "h-9";
  const itemPad = variant === "sheet" ? "px-4" : "px-2";
  const itemClass = `flex w-full items-center gap-2 rounded-sm text-left text-sm hover:bg-accent hover:text-accent-foreground ${itemH} ${itemPad}`;
  return (
    <div className="flex flex-col" data-slot="input-attach-menu">
      <button
        type="button"
        className={itemClass}
        data-slot="input-attach-menu-image"
        onClick={onPickImage}
      >
        <ImageIcon aria-hidden="true" className="size-4" />
        上传图片
      </button>
      <button
        type="button"
        className={itemClass}
        data-slot="input-attach-menu-file"
        onClick={onPickFile}
      >
        <Upload aria-hidden="true" className="size-4" />
        上传文件
      </button>
    </div>
  );
}
