// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区走 BrandHero + 上下文 subtitle；
//   但 authIssue 时改用 EmptyState 全屏告警，避免被 BrandHero 大 logo 喧宾夺主。
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { BrandHero } from "@/components/brand/brand-hero";
import { EmptyState } from "@/components/shell/empty-state";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { getTopLevelSubtitle } from "@/lib/top-level-copy";

export function ProxySelectPage() {
  const proxies = useAppStore((s) => s.proxies);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const relayClientAuthIssue = useAppStore((s) => s.relayClientAuthIssue);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  const desktopSubtitle = getTopLevelSubtitle({
    route: "proxy-select",
    surface: "desktop",
    proxiesLength: proxies.length,
    hasProxy,
    sessionCount,
    relayClientAuthIssue,
  });

  const authEmptyVariant =
    relayClientAuthIssue === "missing_client_token"
      ? "client-token-missing"
      : relayClientAuthIssue === "invalid_client_token"
        ? "client-token-invalid"
        : null;

  return (
    <>
      <div className="h-full md:hidden">
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        {authEmptyVariant ? (
          <EmptyState variant={authEmptyVariant} />
        ) : (
          <BrandHero subtitle={desktopSubtitle} />
        )}
      </div>
    </>
  );
}
