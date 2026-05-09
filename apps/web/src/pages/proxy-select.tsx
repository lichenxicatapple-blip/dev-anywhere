// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区走 BrandHero + 上下文 subtitle
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { BrandHero } from "@/components/brand/brand-hero";
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

  return (
    <>
      <div className="h-full md:hidden">
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <BrandHero subtitle={desktopSubtitle} />
      </div>
    </>
  );
}
