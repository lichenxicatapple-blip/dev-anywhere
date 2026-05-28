import { useAppStore } from "@/stores/app-store";

// chat-pty-view 用来切换内嵌的 trace 复制按钮是否可见。
export function usePtyScrollTraceEnabled(): boolean {
  return useAppStore((s) => s.ptyScrollTraceEnabled);
}
