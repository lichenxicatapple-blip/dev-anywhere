// Chat 页顶栏: 返回按钮 | 会话标题 flex-1 truncate + mode badge | overflow 菜单
// overflow 内容: Rename / Duplicate / 分隔线 / Terminate (destructive)
// Permission mode 归 InputBar 的 ... 菜单 (per-session, 纯触发 Shift+Tab 循环)
import { ArrowLeft, MoreVertical } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

  function handleRename() {
    // session_rename 控制消息未在 shared schema 定义, 占位 toast, 真正接入另起 phase
    toast.info("Rename coming soon");
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
      className="flex items-center gap-2 h-12 px-3 border-b border-border bg-card shrink-0"
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
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          className="text-sm font-semibold truncate"
          data-slot="chat-session-title"
        >
          {session?.name ?? sessionId.slice(0, 8)}
        </span>
        {session?.mode && (
          <Badge
            variant="secondary"
            className="font-mono text-xs uppercase shrink-0"
          >
            {session.mode}
          </Badge>
        )}
      </div>
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
          <DropdownMenuItem onClick={handleRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={handleDuplicate}>Duplicate</DropdownMenuItem>
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
