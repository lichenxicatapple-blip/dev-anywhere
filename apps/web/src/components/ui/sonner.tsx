"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useAppStore } from "@/stores/app-store";

// UI-SPEC §Color + Sonner status mapping
// 主题跟随系统，四种状态走 --color-status-* CSS 变量的 border-l-4 视觉锚。
// 仅导出 Toaster 根组件；业务侧 toast() 调用由 toast 兼容层注入。
export function Toaster() {
  const themePreference = useAppStore((s) => s.themePreference);
  return (
    <SonnerToaster
      theme={themePreference === "auto" ? "system" : themePreference}
      position="top-center"
      toastOptions={{
        classNames: {
          toast: "bg-card text-foreground border border-border",
          success: "border-l-4 !border-l-[var(--color-status-success)]",
          error: "border-l-4 !border-l-[var(--color-status-error)]",
          warning: "border-l-4 !border-l-[var(--color-status-warning)]",
          info: "border-l-4 !border-l-[var(--color-status-working)]",
        },
      }}
    />
  );
}
