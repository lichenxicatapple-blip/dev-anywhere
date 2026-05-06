// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区走 BrandHero + 上下文 subtitle
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { BrandHero } from "@/components/brand/brand-hero";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

export function ProxySelectPage() {
  const proxies = useAppStore((s) => s.proxies);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  let subtitle: string;
  if (proxies.length === 0) subtitle = "在电脑上启动 dev-anywhere。";
  else if (!hasProxy) subtitle = "选择一个 Proxy。";
  else if (sessionCount === 0) subtitle = "在电脑上启动 dev-anywhere，或新建会话。";
  else subtitle = "选择一个会话继续，或新建。";

  return (
    <>
      <div className="md:hidden h-full">
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <BrandHero subtitle={subtitle} />
      </div>
    </>
  );
}
