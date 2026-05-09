// 桌面端有常驻侧栏，返回入口只在移动端显示。
import { ArrowLeft, Minus, MoreVertical, Plus } from "lucide-react";
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
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuCheckboxItem
            checked={screenWakeLock.active}
            disabled={screenWakeLock.pending}
            data-slot="chat-menu-screen-wake-lock-item"
            onCheckedChange={toggleScreenWakeLock}
          >
            {screenWakeLock.supported ? "屏幕常亮" : "屏幕常亮（浏览器不支持）"}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground">
            {isPty ? "终端字号" : "聊天字号"}
          </DropdownMenuLabel>
          <div className="px-2 pb-1.5" data-slot="chat-menu-font-control">
            <div
              className="flex h-11 items-center gap-1 rounded-lg bg-muted/35 md:h-9"
              data-slot="chat-menu-font-stepper"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-11 rounded-lg text-muted-foreground hover:bg-background/70 hover:text-foreground md:size-8"
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
                className="flex h-9 min-w-[3.35rem] flex-1 items-center justify-center rounded-md bg-background/75 text-sm tabular-nums text-foreground shadow-xs md:h-8 md:min-w-[3rem]"
                data-slot="chat-menu-font-size"
              >
                {fontSize}px
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-11 rounded-lg text-muted-foreground hover:bg-background/70 hover:text-foreground md:size-8"
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
    </div>
  );
}
