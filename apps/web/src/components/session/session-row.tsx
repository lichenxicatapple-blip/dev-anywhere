// 会话列表单行：selected 时带 amber 左边条 + amber/8 背景
// mode badge 走 shadcn Badge variant="secondary"
// 状态点走 UI-SPEC --color-status-* tokens
// 操作菜单（终止会话等）走 shadcn DropdownMenu —— 不移植 Feishu 的 swipe-to-terminate 手势
import { MoreHorizontal } from "lucide-react";
import type { SessionInfo } from "@cc-anywhere/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relative-time";

// SessionInfo 可选字段扩展：部分来源（如本地新建）会提供 lastActive 时间戳
// shared schema 当前不含 lastActive，但 row 侧必须防御式读取
type SessionWithLastActive = SessionInfo & { lastActive?: number };

interface SessionRowProps {
  session: SessionInfo;
  selected: boolean;
  onClick: () => void;
  onTerminate?: () => void;
}

function StateDot({ state }: { state: SessionInfo["state"] }) {
  // SessionInfo.state 枚举：idle | working | waiting_approval | error | terminated
  const colorClass =
    state === "working"
      ? "bg-[var(--color-status-working)] animate-pulse"
      : state === "waiting_approval"
        ? "bg-[var(--color-status-warning)]"
        : state === "error"
          ? "bg-[var(--color-status-error)]"
          : state === "terminated"
            ? "bg-muted-foreground"
            : "bg-[var(--color-status-success)]"; // idle
  return (
    <span
      className={cn("inline-block size-2 rounded-full shrink-0", colorClass)}
      aria-label={`Session state: ${state}`}
      role="status"
    />
  );
}

export function SessionRow({ session, selected, onClick, onTerminate }: SessionRowProps) {
  const lastActive = (session as SessionWithLastActive).lastActive;
  return (
    <li
      className={cn(
        "relative flex items-center gap-2 px-3 w-full min-w-0 transition-colors",
        "min-h-[44px] md:h-9 md:min-h-0",
        "hover:bg-accent",
        selected && "bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]",
      )}
      data-slot="session-row"
      data-session-id={session.sessionId}
      data-selected={selected}
    >
      {selected && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary"
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 flex-1 min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-pressed={selected}
      >
        <StateDot state={session.state} />
        <span className="text-sm font-normal truncate flex-1">
          {session.name || session.sessionId.slice(0, 8)}
        </span>
        {session.mode && (
          <Badge variant="secondary" className="font-mono text-xs uppercase shrink-0">
            {session.mode}
          </Badge>
        )}
        {lastActive !== undefined && (
          <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
            {formatRelativeTime(lastActive)}
          </span>
        )}
      </button>
      {onTerminate && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="会话操作"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={onTerminate}>
              终止会话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}
