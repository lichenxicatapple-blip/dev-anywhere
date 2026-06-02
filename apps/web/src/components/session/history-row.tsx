// 历史会话单行: 点击即 resume
// 总在某个 projectDir group 下渲染, 所以本行不再重复展示 projectDir。
// 标题与时间分两行：历史标题信息量优先，时间作为小号副信息避免挤压标题。
// 行内不放前导图标: 每行前导时钟图标信息量为零 (group header 已表达"历史"语义), 纯靠左侧 pl-10 缩进体现层级
import { ArrowUpRight, MessageSquare, TerminalSquare } from "lucide-react";
import type { HistorySession } from "@dev-anywhere/shared";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relative-time";

type RestoreMode = "pty" | "json";

interface HistoryRowProps {
  session: HistorySession;
  // 由父层每 60s 推进的参考 now, 驱动相对时间自刷新
  now?: number;
  // 有别的 resume 请求在飞时置灰本行
  disabled?: boolean;
  // 当前正在 resume 的行: 显示 loading 而不是箭头
  loading?: boolean;
  onClick?: () => void;
  modeTag?: RestoreMode;
}

export function HistoryRow({ session, now, disabled, loading, onClick, modeTag }: HistoryRowProps) {
  const title = <HistoryTitle title={session.title} modeTag={modeTag} />;
  const timestamp = (
    <span className="text-xs text-muted-foreground tabular-nums">
      {formatRelativeTime(session.updatedAt, now)}
    </span>
  );
  const content = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {title}
      {timestamp}
    </span>
  );

  return (
    <li
      data-slot="history-row"
      data-session-id={session.id}
      data-loading={loading ? "true" : undefined}
      className="group w-full flex items-stretch"
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-slot="history-row-primary"
        className={cn(
          "min-w-0 flex-1 flex items-start gap-2 pl-10 pr-4 py-2 min-h-[50px]",
          "text-left transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:opacity-50 disabled:cursor-wait disabled:hover:bg-transparent",
        )}
        aria-label={`恢复会话：${session.title}`}
      >
        {content}
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

function HistoryTitle({ title, modeTag }: { title: string; modeTag?: RestoreMode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-sm font-normal truncate min-w-0" title={title}>
        {title}
      </span>
      {modeTag && <HistoryModeTag mode={modeTag} />}
    </span>
  );
}

function HistoryModeTag({ mode }: { mode: RestoreMode }) {
  const label = mode === "json" ? "聊天视图" : "终端视图";
  const Icon = mode === "json" ? MessageSquare : TerminalSquare;

  return (
    <span
      data-slot="history-mode-tag"
      data-mode={mode}
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded border",
        "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
    </span>
  );
}
