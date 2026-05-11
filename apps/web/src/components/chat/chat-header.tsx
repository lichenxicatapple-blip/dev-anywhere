// 桌面端有常驻侧栏，返回入口只在移动端显示。
import { ArrowLeft, Minus, MoreVertical, Plus, Upload } from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSessionStore } from "@/stores/session-store";
import {
  getEffectiveChatContentFontSize,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MOBILE_CHAT_CONTENT_FONT_SIZE_MIN,
} from "@/lib/chat-font-size";
import { useAppStore } from "@/stores/app-store";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useScreenWakeLockScope } from "@/hooks/use-screen-wake-lock";
import { toast } from "@/components/toast";
import { fileToUploadPayload } from "@/lib/file-upload-payload";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface ChatHeaderProps {
  sessionId: string;
  mode?: "json" | "pty";
}

function splitPtyTitle(title: string): { indicator?: string; label: string } {
  const [indicator, space, ...rest] = Array.from(title);
  if (indicator && space === " " && rest.length > 0) {
    return { indicator, label: rest.join("") };
  }
  return { label: title };
}

function ChatSessionTitle({ title, isPtyTitle }: { title: string; isPtyTitle: boolean }) {
  if (!isPtyTitle) {
    return <>{title}</>;
  }

  const { indicator, label } = splitPtyTitle(title);
  return (
    <span className="inline-flex items-center justify-center max-w-full min-w-0 font-mono font-normal">
      {indicator && (
        <span className="inline-block w-[1.25ch] shrink-0 text-center" aria-hidden="true">
          {indicator}
        </span>
      )}
      <span className="truncate">{indicator ? ` ${label}` : label}</span>
    </span>
  );
}

export function ChatHeader({ sessionId, mode }: ChatHeaderProps) {
  const navigate = useNavigate();
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const chatContentFontSize = useAppStore((s) => s.chatContentFontSize);
  const adjustPtyFontSize = useAppStore((s) => s.adjustPtyFontSize);
  const adjustChatContentFontSize = useAppStore((s) => s.adjustChatContentFontSize);
  const setChatContentFontSize = useAppStore((s) => s.setChatContentFontSize);
  const resetPtyFontSize = useAppStore((s) => s.resetPtyFontSize);
  const resetChatContentFontSize = useAppStore((s) => s.resetChatContentFontSize);
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const isPty = mode === "pty" || session?.mode === "pty";
  const screenWakeLock = useScreenWakeLockScope(sessionId);
  const title = (isPty && ptyTitle) || session?.name || sessionId.slice(0, 8);
  const fontSize = isPty
    ? ptyFontSize
    : getEffectiveChatContentFontSize(chatContentFontSize, touchEditingSurface);
  const minFontSize =
    !isPty && touchEditingSurface ? MOBILE_CHAT_CONTENT_FONT_SIZE_MIN : MIN_CHAT_FONT_SIZE;
  const resetFontSize = isPty ? resetPtyFontSize : resetChatContentFontSize;

  function adjustFontSize(delta: number) {
    if (isPty) {
      adjustPtyFontSize(delta);
      return;
    }
    if (touchEditingSurface) {
      setChatContentFontSize(fontSize + delta);
      return;
    }
    adjustChatContentFontSize(delta);
  }

  function toggleScreenWakeLock() {
    void screenWakeLock.toggle().catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }

  // PTY 模式上传文件: 触发隐藏 input → 读字节 → relay.uploadFile → 把返回路径作为
  // "@<path> " 文本写到终端 stdin, 用户接着回车或自己拼到命令里 (与图片粘贴同形状)。
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFilePicked(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const toastId = toast.loading(`上传 ${file.name} ...`);
    try {
      const payload = await fileToUploadPayload(file);
      const result = await relay.uploadFile(sessionId, payload);
      if (!result.success || !result.path) {
        toast.error(result.error ?? "上传失败", { id: toastId });
        return;
      }
      sendRemoteInputRaw(sessionId, `@${result.path} `);
      toast.success(`已上传 ${result.path}`, { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
    }
  }

  return (
    <div
      className="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center min-h-12 px-3 pt-[env(safe-area-inset-top)] border-b border-border bg-card shrink-0"
      data-slot="chat-header"
    >
      <div className="flex justify-start">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={() => navigate("/sessions")}
          aria-label="返回会话列表"
          data-slot="chat-back-button"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
      </div>
      {/* 中间列 text-center + truncate: 长标题省略号, 短标题居中 */}
      <span
        className="text-sm font-semibold truncate text-center px-2"
        data-slot="chat-session-title"
      >
        <ChatSessionTitle title={title} isPtyTitle={Boolean(isPty && ptyTitle)} />
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="会话操作"
            data-slot="chat-overflow-trigger"
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          style={{ maxWidth: "calc(100vw - 1rem)" }}
          data-slot="chat-overflow-menu"
        >
          {isPty ? (
            <>
              <DropdownMenuLabel className="text-muted-foreground">快捷键</DropdownMenuLabel>
              <DropdownMenuItem
                data-slot="chat-menu-send-ctrl-t"
                onClick={() => sendRemoteInputRaw(sessionId, "\x14")}
              >
                发送 Ctrl+T
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="chat-menu-send-ctrl-c"
                onClick={() => sendRemoteInputRaw(sessionId, "\x03")}
              >
                发送 Ctrl+C
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="chat-menu-send-shift-tab"
                onClick={() => sendRemoteInputRaw(sessionId, "\x1b[Z")}
              >
                发送 Shift+Tab
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="chat-menu-send-ctrl-b"
                onClick={() => sendRemoteInputRaw(sessionId, "\x02")}
              >
                发送 Ctrl+B
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="chat-menu-send-ctrl-o"
                onClick={() => sendRemoteInputRaw(sessionId, "\x0f")}
              >
                发送 Ctrl+O
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground">文件</DropdownMenuLabel>
              <DropdownMenuItem
                data-slot="chat-menu-upload-file"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload aria-hidden="true" />
                上传文件
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel className="text-muted-foreground">显示</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={screenWakeLock.active}
            className="justify-start pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2"
            disabled={screenWakeLock.pending || !screenWakeLock.supported}
            data-slot="chat-menu-screen-wake-lock-item"
            onCheckedChange={toggleScreenWakeLock}
          >
            {screenWakeLock.supported ? "屏幕常亮" : "屏幕常亮（浏览器不支持）"}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground">
            {isPty ? "终端字号" : "聊天字号"}
          </DropdownMenuLabel>
          <div className="px-2 pb-1" data-slot="chat-menu-font-control">
            <div
              className="grid h-10 grid-cols-[2.75rem_minmax(3rem,1fr)_2.75rem] items-center gap-1"
              data-slot="chat-menu-font-stepper"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-0.5 size-11 rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                disabled={fontSize <= minFontSize}
                aria-label="字号变小"
                data-slot="chat-menu-font-smaller"
                onClick={(event) => {
                  event.stopPropagation();
                  adjustFontSize(-1);
                }}
              >
                <Minus aria-hidden="true" />
              </Button>
              <span
                className="flex h-8 min-w-[3rem] items-center justify-center rounded-sm bg-muted/45 text-sm tabular-nums text-foreground"
                data-slot="chat-menu-font-size"
              >
                {fontSize}px
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-0.5 size-11 rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                disabled={fontSize >= MAX_CHAT_FONT_SIZE}
                aria-label="字号变大"
                data-slot="chat-menu-font-larger"
                onClick={(event) => {
                  event.stopPropagation();
                  adjustFontSize(1);
                }}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </div>
          <DropdownMenuItem data-slot="chat-menu-font-reset" onClick={resetFontSize}>
            恢复默认
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isPty ? (
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          data-slot="chat-menu-upload-file-input"
          onChange={(event) => {
            void handleFilePicked(event);
          }}
        />
      ) : null}
    </div>
  );
}
