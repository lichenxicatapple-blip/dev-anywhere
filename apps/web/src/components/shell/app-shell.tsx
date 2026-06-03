import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Monitor, Settings } from "lucide-react";
import { Sidebar } from "./sidebar";
import { SettingsDialog } from "./settings-dialog";
import { MobileBrandHero } from "@/components/brand/mobile-brand-hero";
import { LatencyMonitor } from "@/components/diagnostics/latency-monitor";
import { Toaster, toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { PtyAutoYesController } from "@/components/chat/pty-auto-yes-controller";
import { PtyKeepAliveProvider } from "@/components/chat/pty-keepalive-provider";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { getTopLevelSubtitle } from "@/lib/top-level-subtitle";
import { cn } from "@/lib/utils";
import { useVisualViewportHeightVar } from "@/hooks/use-visual-viewport";
import {
  clearLastChatRoute,
  hasRestoredThisSession,
  markRestoredTarget,
  markRestoredThisSession,
  pickRouteToRestore,
  readLastChatRoute,
  writeLastChatRoute,
} from "@/lib/route-restore";

function isStandaloneDisplay() {
  if (typeof window === "undefined") return false;
  const mediaStandalone =
    typeof window.matchMedia === "function" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches);
  const navigatorStandalone =
    typeof navigator !== "undefined" &&
    "standalone" in navigator &&
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return mediaStandalone || navigatorStandalone;
}

export function AppShell() {
  useVisualViewportHeightVar();
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith("/chat/");
  const isTopLevelRoute = location.pathname === "/" || location.pathname === "/sessions";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [standaloneDisplay, setStandaloneDisplay] = useState(() => isStandaloneDisplay());
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

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setStandaloneDisplay(isStandaloneDisplay());
      return;
    }
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const fullscreenQuery = window.matchMedia("(display-mode: fullscreen)");
    const update = () => setStandaloneDisplay(isStandaloneDisplay());
    update();
    standaloneQuery.addEventListener("change", update);
    fullscreenQuery.addEventListener("change", update);
    return () => {
      standaloneQuery.removeEventListener("change", update);
      fullscreenQuery.removeEventListener("change", update);
    };
  }, []);

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
    if (target) {
      // 标 chat 页一会儿能识别 "我是被 auto-restore 拽来的", 撞已死会话时 silent 退回 /sessions
      markRestoredTarget(target);
      navigate(target, { replace: true });
    }
    // 只在首挂载跑, 不依赖 location/navigate 变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持续追踪 chat 路由, 用户主动从 chat 离开 (chat → /sessions / chat → /) 视为放弃恢复意图,
  // 清掉 last-chat-route, 防止下次冷启动 / PWA 拉起被拽回上一个会话。
  // mount 时 isChatRoute=false 不算"离开" (cold-start 还没读 last-chat-route, 清了 restore 就没了);
  // 用 ref 把 isChatRoute 从 false 起步的初始 render 跟后续 transition 区分。
  const wasChatRouteRef = useRef(false);
  useEffect(() => {
    if (isChatRoute) {
      wasChatRouteRef.current = true;
      writeLastChatRoute(`${location.pathname}${location.search}`);
    } else if (wasChatRouteRef.current) {
      wasChatRouteRef.current = false;
      clearLastChatRoute();
    }
  }, [isChatRoute, location.pathname, location.search]);

  return (
    <div
      className="flex flex-col bg-background text-foreground"
      style={{
        height:
          "var(--dev-app-shell-height, max(100dvh, var(--dev-visual-viewport-height, 100dvh)))",
      }}
      data-slot="app-shell"
      data-standalone-display={standaloneDisplay ? "true" : undefined}
    >
      {!isChatRoute && (
        <Button
          variant="ghost"
          size="icon"
          className="dev-mobile-settings-trigger group fixed right-4 z-30 size-11 rounded-full border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground md:hidden"
          aria-label="设置"
          data-slot="mobile-settings-trigger"
          onClick={() => setSettingsOpen(true)}
        >
          <span
            data-slot="mobile-settings-trigger-visual"
            className="flex size-7 items-center justify-center rounded-full border border-border/80 bg-card/90 shadow-lg backdrop-blur transition-colors group-hover:border-primary/45 group-hover:bg-accent"
          >
            <Settings className="size-4" aria-hidden="true" />
          </span>
        </Button>
      )}

      {!isChatRoute && <MobileBrandHero subtitle={mobileSubtitle} action={mobileHeroAction} />}

      <PtyAutoYesController />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar className="hidden md:flex" />
        <main className="relative flex-1 overflow-hidden" role="main">
          <PtyKeepAliveProvider>
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
          </PtyKeepAliveProvider>
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <LatencyMonitor />
      <Toaster />
    </div>
  );
}
