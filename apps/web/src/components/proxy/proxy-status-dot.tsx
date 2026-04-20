// 8px 圆点指示 proxy 的连接状态
// 颜色映射 UI-SPEC Color 里的 --color-status-* tokens
import { cn } from "@/lib/utils";

interface ProxyStatusDotProps {
  status: "online" | "offline" | "connecting";
  className?: string;
}

const DOT_CLASS: Record<ProxyStatusDotProps["status"], string> = {
  online: "bg-[var(--color-status-success)]",
  offline: "bg-[var(--muted-foreground)]",
  connecting: "bg-[var(--color-status-working)] animate-pulse",
};

export function ProxyStatusDot({ status, className }: ProxyStatusDotProps) {
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-full shrink-0", DOT_CLASS[status], className)}
      role="status"
      aria-label={`Proxy status: ${status}`}
    />
  );
}
