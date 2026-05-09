// 历史会话单行: 点击即 resume
// 总在某个 projectDir group 下渲染, 所以本行不再重复展示 projectDir。
// 标题与时间分两行：历史标题信息量优先，时间作为小号副信息避免挤压标题。
// 行内不放图标: 每行前导时钟图标信息量为零 (group header 已表达"历史"语义), 纯靠左侧 pl-10 缩进体现层级
import { ArrowUpRight } from "lucide-react";
import type { HistorySession } from "@dev-anywhere/shared";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relative-time";

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

export function HistoryRow({ session, now, disabled, loading, onClick }: HistoryRowProps) {
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
          "group w-full flex items-start gap-2 pl-10 pr-4 py-2 min-h-[50px]",
          "text-left transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:opacity-50 disabled:cursor-wait disabled:hover:bg-transparent",
        )}
        aria-label={`恢复会话：${session.title}`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-normal truncate min-w-0">{session.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatRelativeTime(session.updatedAt, now)}
          </span>
        </span>
        <ArrowUpRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-opacity",
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
