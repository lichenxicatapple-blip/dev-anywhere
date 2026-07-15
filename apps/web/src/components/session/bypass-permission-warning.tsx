import { TriangleAlert } from "lucide-react";

interface BypassPermissionWarningProps {
  providerLabel: string;
}

export function BypassPermissionWarning({ providerLabel }: BypassPermissionWarningProps) {
  return (
    <div className="grid min-w-0 gap-4" data-slot="bypass-permission-warning" role="alert">
      <div className="flex min-w-0 items-start gap-3 text-sm">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="grid min-w-0 gap-2">
          <p className="font-medium text-foreground">{providerLabel} 将不再请求工具审批。</p>
          <p className="text-muted-foreground">
            Agent 可以直接执行命令、修改或删除文件，并可能绕过部分沙箱保护。
          </p>
        </div>
      </div>
    </div>
  );
}
