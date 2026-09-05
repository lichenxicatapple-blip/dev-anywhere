import { Loader2 } from "lucide-react";
import type { RelayConnectionIssue } from "@/stores/app-store";
import { Button } from "@/components/ui/button";

export function RelayUnavailableState({ issue }: { issue: RelayConnectionIssue }) {
  const message =
    issue === "unreachable"
      ? "暂时无法连接"
      : issue === "page_outdated"
        ? "当前页面版本较旧，请刷新后重试"
        : issue === "service_outdated"
          ? "服务端版本较旧，请更新服务后重试"
          : issue === "protocol_mismatch"
            ? "页面与服务端版本不一致，请刷新后重试"
            : "连接已断开";
  const actionLabel =
    issue === "page_outdated" || issue === "protocol_mismatch"
      ? "刷新页面"
      : issue === "service_outdated"
        ? "重新检测"
        : null;
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground"
      data-slot="relay-connection-state"
      data-state="unavailable"
      data-issue={issue}
      role="status"
      aria-live="polite"
    >
      {issue === "unreachable" ? (
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      ) : null}
      <p className="text-sm">{message}</p>
      {actionLabel ? (
        <Button type="button" size="sm" onClick={() => window.location.reload()}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
