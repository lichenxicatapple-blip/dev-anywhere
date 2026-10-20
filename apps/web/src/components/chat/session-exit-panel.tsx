import type { SessionExitInfo } from "@dev-anywhere/shared";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

function describeExit(
  exit: SessionExitInfo | undefined,
  mode: "json" | "pty",
  channelFailed: boolean,
) {
  const subject = mode === "pty" ? "终端" : "会话";
  if (exit?.reason === "user-terminated") {
    return { title: "会话已结束", message: "已手动结束此远程会话。", error: false };
  }
  if (exit?.reason === "connection-lost" || (!exit && channelFailed)) {
    return {
      title: `${subject}连接已中断`,
      message: "与开发机上的进程通道已中断，暂时无法确认进程是否仍在运行。",
      error: true,
    };
  }
  if (exit?.exitCode === 0) {
    return { title: `${subject}已结束`, message: "进程已正常退出。", error: false };
  }
  if (exit?.exitCode !== undefined) {
    return {
      title: `${subject}异常退出`,
      message: "开发机上的进程异常退出，当前会话已结束。",
      error: true,
    };
  }
  return {
    title: `${subject}已结束`,
    message: exit?.details ? "进程已退出，可展开查看详情。" : "未收到具体退出原因。",
    error: false,
  };
}

export function SessionExitPanel({
  exit,
  mode,
  channelFailed = false,
  onBack,
}: {
  exit?: SessionExitInfo;
  mode: "json" | "pty";
  channelFailed?: boolean;
  onBack: () => void;
}) {
  const description = describeExit(exit, mode, channelFailed);
  const hasDetails = exit?.exitCode !== undefined || Boolean(exit?.details);
  return (
    <div
      className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-6 py-8 text-center"
      data-slot={channelFailed ? "failed-session-panel" : "terminated-session-panel"}
      role={description.error ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="my-auto flex w-full max-w-lg flex-col items-center gap-4">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{description.title}</h2>
          <p className="text-sm text-muted-foreground">{description.message}</p>
        </div>
        {hasDetails && (
          <details className="w-full rounded-md border p-3 text-left text-sm">
            <summary className="cursor-pointer select-none">
              {description.error ? "错误详情" : "退出详情"}
            </summary>
            {exit?.exitCode !== undefined && (
              <p className="mt-3 text-muted-foreground">退出码：{exit.exitCode}</p>
            )}
            {exit?.details && (
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {exit.details}
              </pre>
            )}
          </details>
        )}
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          返回会话列表
        </Button>
      </div>
    </div>
  );
}
