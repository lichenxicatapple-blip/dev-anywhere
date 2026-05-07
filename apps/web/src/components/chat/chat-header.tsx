// Chat 页顶栏: 返回按钮 | 会话标题 flex-1 truncate + mode badge | overflow 菜单
// PTY 模式没有下方 InputBar，终端级控制入口归这里。
import { useState } from "react";
import { ArrowLeft, MoreVertical } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { SessionTerminationDialog } from "@/components/session/session-termination-dialog";

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
  const [terminationOpen, setTerminationOpen] = useState(false);
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const setPtyAutoscale = useAppStore((s) => s.setPtyAutoscale);
  const isPty = session?.mode === "pty";
  const isLocalTerminalPty = session?.mode === "pty" && session.ptyOwner === "local-terminal";
  const title = (isPty && ptyTitle) || session?.name || sessionId.slice(0, 8);
  const terminateLabel = isLocalTerminalPty ? "断开远程连接" : "终止会话";

  function handleTerminate(targetSession = session) {
    if (!targetSession) return;
    relayClientRef?.sendControl({ type: "session_terminate", sessionId: targetSession.sessionId });
    navigate("/sessions");
  }

  function handlePermissionModeCycle() {
    relayClientRef?.sendControl({
      type: "permission_mode_change",
      mode: "default",
      sessionId,
    });
  }

  return (
    <>
      <div
        className="grid grid-cols-[auto_1fr_auto] items-center min-h-12 px-3 pt-[env(safe-area-inset-top)] border-b border-border bg-card shrink-0"
        data-slot="chat-header"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate("/sessions")}
          aria-label="返回会话列表"
          data-slot="chat-back-button"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
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
            {isPty && (
              <>
                <DropdownMenuItem onClick={handlePermissionModeCycle}>
                  切换权限模式
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPtyAutoscale(!ptyAutoscale)}>
                  终端字号自适应：{ptyAutoscale ? "开" : "关"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => sendRemoteInputRaw(sessionId, "\x03")}>
                  发送 Ctrl+C
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              className={isLocalTerminalPty ? undefined : "text-destructive focus:text-destructive"}
              data-slot="chat-terminate-item"
              onClick={() => setTerminationOpen(true)}
            >
              {terminateLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SessionTerminationDialog
        open={terminationOpen}
        session={session ?? null}
        onOpenChange={setTerminationOpen}
        onConfirm={handleTerminate}
      />
    </>
  );
}
