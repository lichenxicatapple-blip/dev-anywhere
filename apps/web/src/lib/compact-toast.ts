import { toast } from "@/components/toast";

function compactToastId(sessionId: string): string {
  return `compact-${sessionId}`;
}

export function showCompactStartToast(sessionId: string): void {
  toast.loading("正在压缩上下文...", { id: compactToastId(sessionId) });
}

export function showCompactEndToast(sessionId: string, success: boolean, result?: string): void {
  const id = compactToastId(sessionId);
  if (success) {
    toast.success("上下文压缩完成", { id });
    return;
  }
  toast.error(result?.trim() || "上下文压缩失败", { id });
}
