import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Monitor, Settings } from "lucide-react";
import { Sidebar } from "./sidebar";
import { SettingsDialog } from "./settings-dialog";
import { MobileBrandHero } from "@/components/brand/mobile-brand-hero";
import { Toaster, toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { getTopLevelSubtitle } from "@/lib/top-level-copy";
import { cn } from "@/lib/utils";
import { useVisualViewportHeightVar } from "@/hooks/use-visual-viewport";
import {
  hasRestoredThisSession,
  markRestoredThisSession,
  pickRouteToRestore,
  readLastChatRoute,
  writeLastChatRoute,
} from "@/lib/route-restore";

export function AppShell() {
  useVisualViewportHeightVar();
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith("/chat/");
  const isTopLevelRoute = location.pathname === "/" || location.pathname === "/sessions";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const proxiesLength = useAppStore((s) => s.proxies.length);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  const relayClientAuthIssue = useAppStore((s) => s.relayClientAuthIssue);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const selectedProxyName = useAppStore((s) => s.selectedProxyName);
  const sessionCount = useSessionStore((s) => s.sessions.length);
  const pendingToast = useAppStore((s) => s.pendingToast);
  const setPendingToast = useAppStore((s) => s.setPendingToast);
  const topLevelRoute = location.pathname === "/" ? "proxy-select" : "sessions";
  const mobileSubtitle = getTopLevelSubtitle({
    route: topLevelRoute,
    surface: "mobile",
    proxiesLength,
    hasProxy,
    sessionCount,
    relayClientAuthIssue,
  });
  const selectedProxyLabel = selectedProxyName ?? selectedProxyId;
  const showSwitchProxyAction =
    location.pathname === "/sessions" && proxyListLoaded && proxiesLength > 0;
  const mobileHeroAction = showSwitchProxyAction ? (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto min-h-11 max-w-full justify-start rounded-md border border-border/70 bg-background/35 px-3 py-2 text-left text-muted-foreground hover:border-primary/45 hover:bg-accent/70 hover:text-foreground"
      data-slot="mobile-switch-proxy"
      aria-label={selectedProxyLabel ? `切换开发机，当前 ${selectedProxyLabel}` : "切换开发机"}
      onClick={() => navigate("/")}
    >
      <Monitor className="size-4 text-primary" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">切换开发机</span>
        {selectedProxyLabel ? (
          <span className="ml-1 text-muted-foreground/75">· {selectedProxyLabel}</span>
        ) : null}
      </span>
    </Button>
  ) : null;

  // 通知容器挂载后，消费启动阶段暂存的消息。
  useEffect(() => {
    if (!pendingToast) return;
    const fns = { error: toast.error, info: toast.info, success: toast.success };
    fns[pendingToast.kind](pendingToast.message);
    setPendingToast(null);
  }, [pendingToast, setPendingToast]);

  // 冷启动恢复上次 chat 路由: 仅首次挂载评估一次, 后续 SPA 内回到 "/" 不再打扰。
  const restoreEvaluatedRef = useRef(false);
  useEffect(() => {
    if (restoreEvaluatedRef.current) return;
    restoreEvaluatedRef.current = true;
    const target = pickRouteToRestore({
      pathname: location.pathname,
      alreadyRestored: hasRestoredThisSession(),
      lastRoute: readLastChatRoute(),
    });
    markRestoredThisSession();
    if (target) navigate(target, { replace: true });
    // 只在首挂载跑, 不依赖 location/navigate 变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持续追踪当前 chat 路由, 落盘最后一次, 供下次冷启动恢复
  useEffect(() => {
    if (!isChatRoute) return;
    writeLastChatRoute(`${location.pathname}${location.search}`);
  }, [isChatRoute, location.pathname, location.search]);

  return (
    <div
      className="flex flex-col bg-background text-foreground"
      style={{ height: "max(100dvh, var(--dev-visual-viewport-height, 100dvh))" }}
      data-slot="app-shell"
    >
      {!isChatRoute && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed right-4 top-[calc(env(safe-area-inset-top)+1.125rem)] z-30 size-11 rounded-full border border-border/80 bg-card/90 text-muted-foreground shadow-lg backdrop-blur hover:border-primary/45 hover:bg-accent hover:text-foreground md:hidden"
          aria-label="设置"
          data-slot="mobile-settings-trigger"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings aria-hidden="true" />
        </Button>
      )}

      {!isChatRoute && <MobileBrandHero subtitle={mobileSubtitle} action={mobileHeroAction} />}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="flex-1 overflow-hidden" role="main">
          {/* 顶层移动页保留 hero 常驻；chat/session 切换仍保留轻量 fade。 */}
          <div
            key={isTopLevelRoute ? "top-level" : location.pathname}
            className={cn(
              "h-full",
              !isTopLevelRoute && "animate-in fade-in-0 duration-200 motion-reduce:animate-none",
            )}
          >
            <Outlet />
          </div>
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster />
    </div>
  );
}
