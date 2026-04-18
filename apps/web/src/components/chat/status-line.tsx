// 状态条, 占位 24px 高, 映射 working/reconnecting/error 四态颜色
import { cn } from "@/lib/utils";

interface StatusLineProps {
  state: "idle" | "working" | "reconnecting" | "error";
  message?: string;
}

const STATE_COLOR: Record<StatusLineProps["state"], string> = {
  idle: "text-muted-foreground",
  working: "text-[var(--color-status-working)]",
  reconnecting: "text-[var(--color-status-warning)]",
  error: "text-[var(--color-status-error)]",
};

export function StatusLine({ state, message }: StatusLineProps) {
  if (state === "idle" && !message) return null;
  return (
    <div
      className="h-6 px-4 flex items-center text-xs border-t border-border"
      data-slot="status-line"
      data-state={state}
    >
      <span className={cn("font-mono", STATE_COLOR[state])}>
        {message ?? state}
      </span>
    </div>
  );
}
