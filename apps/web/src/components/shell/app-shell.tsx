// 应用顶层布局：sticky 48px header + 响应式 master-detail（md 断点以上左侧 280px sidebar）
// Toaster 与 CommandPalette 在此挂载一次，路由切换时不会 unmount（Sonner 持久化依赖）
import { Outlet } from "react-router";
import { Sidebar } from "./sidebar";
import { CommandPalette } from "./command-palette";
import { Toaster } from "@/components/toast";

export function AppShell() {
  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      <header
        className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border"
        role="banner"
      >
        <span className="text-sm font-semibold">CC Anywhere</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="flex-1 overflow-hidden" role="main">
          <Outlet />
        </main>
      </div>

      <Toaster />
      <CommandPalette />
    </div>
  );
}
