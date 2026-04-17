// 应用顶层布局：sticky 48px header + 响应式 master-detail（md 断点以上左侧 280px sidebar）
// Toaster 与 CommandPalette 在此挂载一次，路由切换时不会 unmount（Sonner 持久化依赖）
// CommandPalette 的 open 状态在此维护，以便 header 搜索按钮和 Cmd+K 快捷键共用同一入口
import { useState } from "react";
import { Outlet } from "react-router";
import { Search } from "lucide-react";
import { Sidebar } from "./sidebar";
import { CommandPalette } from "./command-palette";
import { Toaster } from "@/components/toast";

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      <header
        className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border"
        role="banner"
      >
        <span className="text-sm font-semibold">CC Anywhere</span>
        <button
          type="button"
          className="ml-auto flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => setPaletteOpen(true)}
          aria-label="搜索"
          aria-keyshortcuts="Meta+K Control+K"
          data-slot="header-search"
        >
          <Search className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">搜索</span>
          <kbd className="hidden sm:inline text-xs bg-muted px-1.5 py-0.5 rounded border border-border">
            ⌘K
          </kbd>
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="flex-1 overflow-hidden" role="main">
          <Outlet />
        </main>
      </div>

      <Toaster />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
