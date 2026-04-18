// 应用顶层布局；/chat/* 路由隐藏本 header, 由 ChatHeader 接管 (D-51)
import { Outlet, useLocation } from "react-router";
import { Sidebar } from "./sidebar";
import { Toaster } from "@/components/toast";

export function AppShell() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith("/chat/");

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      {!isChatRoute && (
        <header
          className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border"
          role="banner"
          data-slot="app-shell-header"
        >
          <span className="text-sm font-semibold">CC Anywhere</span>
        </header>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="flex-1 overflow-hidden" role="main">
          <Outlet />
        </main>
      </div>

      <Toaster />
    </div>
  );
}
