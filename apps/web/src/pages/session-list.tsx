// /sessions 路由的双视图：
// - Mobile (< md)：SessionList layout="page" 作为全屏列表 + 底部 CTA
// - Desktop (≥ md)：sidebar 已承载 SessionList，主区走 BrandHero + 上下文 subtitle
import { SessionList } from "@/components/session/session-list";
import { BrandHero } from "@/components/brand/brand-hero";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { getTopLevelSubtitle } from "@/lib/top-level-subtitle";
import { readStorageValue, STORAGE_KEYS } from "@/lib/storage-keys";
import { Navigate } from "react-router";

export function SessionListPage() {
  const proxies = useAppStore((s) => s.proxies);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const relayClientAuthIssue = useAppStore((s) => s.relayClientAuthIssue);
  const sessionCount = useSessionStore((s) => s.sessions.length);
  const hasRestorableProxy = readStorageValue("local", STORAGE_KEYS.proxyId) !== null;

  if (!hasProxy && !hasRestorableProxy) {
    return <Navigate to="/" replace />;
  }

  const desktopSubtitle = getTopLevelSubtitle({
    route: "sessions",
    surface: "desktop",
    proxiesLength: proxies.length,
    hasProxy,
    sessionCount,
    relayClientAuthIssue,
  });

  return (
    <>
      <div className="h-full md:hidden">
        <SessionList layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <BrandHero subtitle={desktopSubtitle} />
      </div>
    </>
  );
}
