// 历史会话单行: 点击即 resume
// 对比 SessionRow: 不显示运行状态/操作菜单, 统一展示 title + 缩短 projectDir + 相对时间
// 悬停/禁用态沿用 session-row 的 hover:bg-accent 语言, 让两种 row 在同一列表里视觉一致
import { History, ArrowUpRight } from "lucide-react";
import type { HistorySession } from "@cc-anywhere/shared";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relative-time";
import { formatSessionName } from "@/lib/format-session-name";

interface HistoryRowProps {
  session: HistorySession;
  // 由父层每 60s 推进的参考 now, 驱动相对时间自刷新
  now?: number;
  // 有别的 resume 请求在飞时置灰本行
  disabled?: boolean;
  // 当前正在 resume 的行: 显示 loading 而不是箭头
  loading?: boolean;
  onClick: () => void;
}

export function HistoryRow({
  session,
  now,
  disabled,
  loading,
  onClick,
}: HistoryRowProps) {
  const shortDir = formatSessionName(session.projectDir);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-slot="history-row"
        data-session-id={session.id}
        data-loading={loading ? "true" : undefined}
        className={cn(
          "group w-full flex items-center gap-2 px-4 py-2 min-h-[44px]",
          "text-left transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:opacity-50 disabled:cursor-wait disabled:hover:bg-transparent",
        )}
        aria-label={`恢复会话: ${session.title}`}
      >
        <History
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-sm font-normal truncate">{session.title}</span>
          <span className="flex items-center gap-1.5 text-xs leading-5 h-5 text-muted-foreground min-w-0">
            <span className="truncate font-mono" title={session.projectDir}>
              {shortDir}
            </span>
            <span className="text-muted-foreground/60 shrink-0" aria-hidden>
              ·
            </span>
            <span className="tabular-nums shrink-0">
              {formatRelativeTime(session.updatedAt, now)}
            </span>
          </span>
        </span>
        <ArrowUpRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-opacity",
            loading
              ? "animate-pulse opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
          aria-hidden="true"
        />
      </button>
    </li>
  );
}
