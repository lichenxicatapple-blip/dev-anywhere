// 应用顶层布局；/chat/* 路由隐藏本 header, 由 ChatHeader 接管。
// Settings 齿轮挂在本 header 右侧, 不随 Sidebar 移动。
import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { Settings } from "lucide-react";
import { Sidebar } from "./sidebar";
import { Typewriter } from "@/components/brand/typewriter";
import { Toaster, toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";

// 移动端顶栏品牌: 打字机 loop, 挂在 AppShell header (Outlet 之外) 保证 `/` 与 `/sessions` 间切换不重挂
const BRAND_TEXTS = ["DEV Anywhere", "/unlimited @anytime"];

export function AppShell() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith("/chat/");
  const pendingToast = useAppStore((s) => s.pendingToast);
  const setPendingToast = useAppStore((s) => s.setPendingToast);

  // 消费模块级代码暂存的 toast (phase-machine 冷启动失败等无法直接访问 Sonner 的场景)
  useEffect(() => {
    if (!pendingToast) return;
    const fns = { error: toast.error, info: toast.info, success: toast.success };
    fns[pendingToast.kind](pendingToast.message);
    setPendingToast(null);
  }, [pendingToast, setPendingToast]);

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      {!isChatRoute && (
        <header
          className="sticky top-0 z-10 flex items-center gap-2 px-4 min-h-12 pt-[env(safe-area-inset-top)] bg-card border-b border-border"
          role="banner"
          data-slot="app-shell-header"
        >
          <Typewriter texts={BRAND_TEXTS} className="text-sm font-semibold md:hidden" />
          <span className="hidden md:inline text-sm font-semibold">DEV Anywhere</span>
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="设置"
              data-slot="app-shell-settings-trigger"
              onClick={() => toast.info("Settings coming soon")}
            >
              <Settings aria-hidden="true" />
            </Button>
          </div>
        </header>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="flex-1 overflow-hidden" role="main">
          {/* 路由切换 fade-in: key 绑 pathname, 切会话 (chat/a → chat/b) 也会轻量重放 */}
          <div
            key={location.pathname}
            className="h-full animate-in fade-in-0 duration-200 motion-reduce:animate-none"
          >
            <Outlet />
          </div>
        </main>
      </div>

      <Toaster />
    </div>
  );
}
