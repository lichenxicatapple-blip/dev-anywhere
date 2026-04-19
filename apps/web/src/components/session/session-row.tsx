// 会话列表单行：selected 时带 amber 左边条 + amber/8 背景
// meta 行所有 pill (mode / 状态 / 相对时间) 统一 h-5 text-xs 对齐，避免 shadcn Badge rounded-full 跟裸 span 撞不齐的锯齿感
// 状态点走 UI-SPEC --color-status-* tokens
// 操作菜单（终止会话等）走 shadcn DropdownMenu —— 不移植 Feishu 的 swipe-to-terminate 手势
import { MoreHorizontal } from "lucide-react";
import type { SessionInfo } from "@cc-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relative-time";
import { formatSessionName } from "@/lib/format-session-name";

interface SessionRowProps {
  session: SessionInfo;
  selected: boolean;
  // 由父层每 60s 推进的参考 now，驱动 "N 分钟前" 自刷新；省略时 formatRelativeTime 回退到 Date.now()
  now?: number;
  onClick: () => void;
  onTerminate?: () => void;
}

// state → { dot bg-class, text color-class, 中文文案 }
// idle 走 success token（绿, 与"正常空闲"语义一致），terminated 用静音灰
const STATE_STYLE: Record<
  SessionInfo["state"],
  { dot: string; text: string; label: string }
> = {
  idle: {
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
    label: "空闲",
  },
  working: {
    dot: "bg-[var(--color-status-working)] animate-pulse",
    text: "text-[var(--color-status-working)]",
    label: "工作中",
  },
  waiting_approval: {
    dot: "bg-[var(--color-status-warning)]",
    text: "text-[var(--color-status-warning)]",
    label: "等待审批",
  },
  error: {
    dot: "bg-[var(--color-status-error)]",
    text: "text-[var(--color-status-error)]",
    label: "出错",
  },
  terminated: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    label: "已终止",
  },
};

function StateDot({ state }: { state: SessionInfo["state"] }) {
  const style = STATE_STYLE[state];
  return (
    <span
      className={cn("inline-block size-2 rounded-full shrink-0", style.dot)}
      aria-label={`Session state: ${state}`}
      role="status"
    />
  );
}

export function SessionRow({ session, selected, now, onClick, onTerminate }: SessionRowProps) {
  const lastActive = session.lastActive;
  const displayName =
    formatSessionName(session.name) === "New Session"
      ? session.sessionId.slice(0, 8)
      : formatSessionName(session.name);
  const hasMeta = !!session.mode || lastActive !== undefined;
  return (
    <li
      className={cn(
        "relative flex items-center gap-2 px-4 py-2 w-full min-w-0 transition-colors",
        "min-h-[44px]",
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
        className="flex flex-col gap-1 flex-1 min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-pressed={selected}
      >
        <span className="flex items-center gap-2 min-w-0">
          <StateDot state={session.state} />
          <span className="text-sm font-normal truncate flex-1">{displayName}</span>
        </span>
        {hasMeta && (
          <span className="flex items-center gap-1.5 text-xs leading-5 h-5">
            {session.mode && (
              <span className="font-mono uppercase text-muted-foreground shrink-0 inline-block min-w-[4ch]">
                {session.mode}
              </span>
            )}
            {session.mode && (
              <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">·</span>
            )}
            <span className={cn("shrink-0", STATE_STYLE[session.state].text)}>
              {STATE_STYLE[session.state].label}
            </span>
            {lastActive !== undefined && (
              <>
                <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">·</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {formatRelativeTime(lastActive, now)}
                </span>
              </>
            )}
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
