// Sonner toast 兼容层：在保留 Feishu 时代 showToast/useToast API 的前提下改用 Sonner 作为 backing
// phase-machine、relay-client 等旧调用点通过这里的函数式 API 无改动使用新 toast 系统
import { toast } from "sonner";

// 直接透出 Sonner 原生 toast API，新代码优先用它
export { toast };

// Toaster 组件由 AppShell 在根节点挂载一次，跨路由保持不 unmount
export { Toaster } from "@/components/ui/sonner";

// 旧代码用的无色 toast，对应 Sonner 默认样式
export function showToast(message: string): void {
  toast(message);
}

export function showErrorToast(message: string): void {
  toast.error(message);
}

export function showSuccessToast(message: string): void {
  toast.success(message);
}

export function showWarningToast(message: string): void {
  toast.warning(message);
}

// hook 形式兼容，原 useToastStore 消费者只需替换 import 路径即可
export function useToast() {
  return { toast, dismiss: toast.dismiss };
}
