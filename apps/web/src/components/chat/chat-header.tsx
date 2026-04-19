// Chat 页顶栏: 返回按钮 | 会话标题 flex-1 truncate + mode badge | overflow 菜单
// overflow 内容: Rename / Duplicate / 分隔线 / Terminate (destructive)
// Permission mode 归 InputBar 的 ... 菜单 (per-session, 纯触发 Shift+Tab 循环)
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
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";

interface ChatHeaderProps {
  sessionId: string;
}

export function ChatHeader({ sessionId }: ChatHeaderProps) {
  const navigate = useNavigate();
  const session = useSessionStore((s) =>
    s.sessions.find((x) => x.sessionId === sessionId),
  );
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);

  function handleRename() {
    // session_rename 控制消息未在 shared schema 定义, 占位 toast, 真正接入另起 phase
    toast.info("重命名功能即将加入");
  }

  function handleDuplicate() {
    // 以当前 session 为种子创建一个新会话, cwd 透传
    const relay = relayClientRef;
    if (!relay) {
      toast.error("Relay 客户端未就绪");
      return;
    }
    // SessionInfo 不含 cwd 字段, 无从读取, 暂以 "." 作 fallback
    relay.sendControl({ type: "session_create", cwd: "." });
    toast.info("正在创建副本会话...");
  }

  function handleTerminate() {
    relayClientRef?.sendControl({ type: "session_terminate", sessionId });
    navigate("/sessions");
  }

  return (
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
        {(session?.mode === "pty" && ptyTitle) ||
          session?.name ||
          sessionId.slice(0, 8)}
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
          <DropdownMenuItem onClick={handleRename}>重命名</DropdownMenuItem>
          <DropdownMenuItem onClick={handleDuplicate}>复制会话</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            data-slot="chat-terminate-item"
            onClick={handleTerminate}
          >
            终止会话
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
