// 桌面端有常驻侧栏，返回入口只在移动端显示。
import { ArrowLeft, Minus, MoreVertical, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSessionStore } from "@/stores/session-store";
import { MAX_PTY_FONT_SIZE, MIN_PTY_FONT_SIZE, useAppStore } from "@/stores/app-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";

interface ChatHeaderProps {
  sessionId: string;
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

export function ChatHeader({ sessionId }: ChatHeaderProps) {
  const navigate = useNavigate();
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const adjustPtyFontSize = useAppStore((s) => s.adjustPtyFontSize);
  const resetPtyFontSize = useAppStore((s) => s.resetPtyFontSize);
  const requestPtyFit = useAppStore((s) => s.requestPtyFit);
  const isPty = session?.mode === "pty";
  const title = (isPty && ptyTitle) || session?.name || sessionId.slice(0, 8);

  function handlePermissionModeCycle() {
    relayClientRef?.sendControl({
      type: "permission_mode_change",
      mode: "default",
      sessionId,
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
        <DropdownMenuContent align="end" data-slot="chat-overflow-menu">
          <DropdownMenuLabel className="text-muted-foreground">会话</DropdownMenuLabel>
          <DropdownMenuItem
            data-slot="chat-menu-permission-mode"
            onClick={handlePermissionModeCycle}
          >
            切换权限模式
          </DropdownMenuItem>
          {isPty ? (
            <>
              <DropdownMenuItem
                data-slot="chat-menu-send-ctrl-c"
                onClick={() => sendRemoteInputRaw(sessionId, "\x03")}
              >
                发送 Ctrl+C
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground">字号</DropdownMenuLabel>
              <div
                className="flex items-center gap-2 px-2 py-1.5"
                data-slot="chat-menu-font-control"
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={ptyFontSize <= MIN_PTY_FONT_SIZE}
                  aria-label="字号变小"
                  data-slot="chat-menu-font-smaller"
                  onClick={(event) => {
                    event.stopPropagation();
                    adjustPtyFontSize(-1);
                  }}
                >
                  <Minus aria-hidden="true" />
                </Button>
                <span
                  className="min-w-11 text-center text-sm tabular-nums"
                  data-slot="chat-menu-font-size"
                >
                  {ptyFontSize}px
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={ptyFontSize >= MAX_PTY_FONT_SIZE}
                  aria-label="字号变大"
                  data-slot="chat-menu-font-larger"
                  onClick={(event) => {
                    event.stopPropagation();
                    adjustPtyFontSize(1);
                  }}
                >
                  <Plus aria-hidden="true" />
                </Button>
              </div>
              <DropdownMenuItem data-slot="chat-menu-font-fit" onClick={requestPtyFit}>
                适应窗口
              </DropdownMenuItem>
              <DropdownMenuItem data-slot="chat-menu-font-reset" onClick={resetPtyFontSize}>
                恢复默认
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
