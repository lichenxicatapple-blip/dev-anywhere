// meta 行所有 pill (mode / 状态 / 相对时间) 统一 h-5 text-xs 对齐，避免 shadcn Badge rounded-full 跟裸 span 撞不齐的锯齿感
// 状态点走 --color-status-* tokens; 选中态走侧栏结构光带, 不复用状态色。
import { MessageSquare, MoreHorizontal, TerminalSquare } from "lucide-react";
import type { SessionInfo } from "@dev-anywhere/shared";
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
import { providerLabel } from "@/lib/session-provider";

interface SessionRowProps {
  session: SessionInfo;
  selected: boolean;
  // 由父层每 60s 推进的参考 now，驱动相对时间自刷新；省略时 formatRelativeTime 回退到 Date.now()
  now?: number;
  onClick: () => void;
  onRename?: () => void;
  onTerminate?: () => void;
}

// state → { dot bg-class, text color-class, 中文文案 }
// idle 走 success token（绿, 与"正常空闲"语义一致），terminated 用静音灰
const STATE_STYLE: Record<SessionInfo["state"], { dot: string; text: string; label: string }> = {
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
  compacting: {
    dot: "bg-[var(--color-status-compacting)] animate-pulse",
    text: "text-[var(--color-status-compacting)]",
    label: "压缩中",
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

function stateStyleForSession(session: SessionInfo): { dot: string; text: string; label: string } {
  if (session.kind !== "terminal") return STATE_STYLE[session.state];
  if (session.state === "terminated") return STATE_STYLE.terminated;
  if (session.state === "error") {
    return {
      dot: "bg-[var(--color-status-error)]",
      text: "text-[var(--color-status-error)]",
      label: "已断开",
    };
  }
  return {
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
    label: "运行中",
  };
}

function SessionStateDot({ session }: { session: SessionInfo }) {
  const style = stateStyleForSession(session);
  return (
    <span
      className={cn("inline-block size-2 rounded-full shrink-0", style.dot)}
      aria-label={`会话状态：${style.label}`}
      role="status"
    />
  );
}

function SessionModeIcon({ mode }: { mode: SessionInfo["mode"] }) {
  if (mode !== "pty" && mode !== "json") return null;

  const label = mode === "json" ? "聊天视图" : "终端视图";
  const Icon = mode === "json" ? MessageSquare : TerminalSquare;

  return (
    <span
      className="inline-flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground"
      role="img"
      aria-label={label}
      title={label}
      data-slot="session-mode-icon"
      data-mode={mode}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

export function SessionRow({
  session,
  selected,
  now,
  onClick,
  onRename,
  onTerminate,
}: SessionRowProps) {
  const lastActive = session.lastActive;
  const rawName = session.cwd ?? session.name ?? session.sessionId;
  const formattedName = formatSessionName(session.name);
  const displayName =
    session.nameLocked && session.name
      ? session.name
      : formattedName === "New Session"
        ? session.sessionId.slice(0, 8)
        : formattedName;
  const hasMeta = !!session.mode || !!session.provider || lastActive !== undefined;
  const lastActiveLabel = lastActive !== undefined ? formatRelativeTime(lastActive, now) : null;
  const isLocalTerminalPty = session.mode === "pty" && session.ptyOwner === "local-terminal";
  const terminateLabel = isLocalTerminalPty ? "断开远程连接" : "终止会话";
  return (
    <li
      className={cn(
        "relative flex items-center gap-2 px-4 py-2 w-full min-w-0 transition-colors",
        "min-h-[44px]",
        "hover:bg-accent",
        selected && "dev-sidebar-active-row",
      )}
      data-slot="session-row"
      data-session-id={session.sessionId}
      data-selected={selected}
    >
      {selected && (
        <span
          className="dev-sidebar-active-indicator absolute left-0 top-0 bottom-0 w-[2px]"
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-11 flex-col justify-center gap-1 flex-1 min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm md:min-h-0"
        aria-pressed={selected}
      >
        <span className="flex items-center gap-2 min-w-0">
          <SessionStateDot session={session} />
          <span className="text-sm font-normal truncate flex-1" title={rawName}>
            {displayName}
          </span>
        </span>
        {hasMeta && (
          <span className="flex items-center gap-1.5 text-xs leading-5 h-5">
            {session.mode && <SessionModeIcon mode={session.mode} />}
            {session.mode && (
              <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">
                ·
              </span>
            )}
            {session.provider && session.kind !== "terminal" && (
              <>
                <span className="font-mono text-muted-foreground shrink-0">
                  {providerLabel(session.provider)}
                </span>
                <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">
                  ·
                </span>
              </>
            )}
            <span className={cn("shrink-0", stateStyleForSession(session).text)}>
              {stateStyleForSession(session).label}
            </span>
            {lastActiveLabel && (
              <>
                <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">
                  ·
                </span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {lastActiveLabel}
                </span>
              </>
            )}
          </span>
        )}
      </button>
      {(onRename || onTerminate) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 md:size-6"
              aria-label="会话操作"
              data-slot="session-row-menu-trigger"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-slot="session-row-menu">
            {onRename && (
              <DropdownMenuItem
                data-slot="session-row-rename-item"
                onSelect={(event) => {
                  event.stopPropagation();
                  onRename();
                }}
              >
                重命名
              </DropdownMenuItem>
            )}
            {onTerminate && (
              <DropdownMenuItem
                variant="destructive"
                data-slot="session-row-terminate-item"
                onSelect={(event) => {
                  event.stopPropagation();
                  onTerminate();
                }}
              >
                {terminateLabel}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}
